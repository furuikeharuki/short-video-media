"""DMM (FANZA) ItemList API から作品データを取得して DB に upsert するバッチ。

GitHub Actions の cron で 1 時間ごとに実行する想定。

仕様メモ:
  - https://affiliate.dmm.com/api/v3/itemlist.html
  - 対象フロア:
      * digital  / videoa  (FANZA ビデオ)
      * digital  / videoc  (アマチュア)
      * mono     / goods   (女優グッズ)
  - 並び順: sort=date  (配信開始日 desc)
  - 1 回の API 呼び出しで最大 100 件 (DMM 仕様)
  - rate limit に配慮して 1 秒に 1 リクエストまでに絞る
  - 既存 content_id がある場合は UPDATE、無ければ INSERT
  - 紐づくジャンル / 女優 / シリーズ / メーカー / レーベル / 監督も登録

環境変数:
  - DMM_API_ID              : DMM Webservice の API ID
  - DMM_AFFILIATE_ID        : DMM API 呼び出し用 ID (末尾 -990〜-999 必須)
                              API レスポンスの `affiliateURL` はこの ID で発行され、
                              そのまま DB / フロントに保存することで DMM 側で
                              クリックが正しくカウントされる。
  - DMM_LINK_AFFILIATE_ID   : (任意) API が affiliateURL を返さない場合に組み立てる
                              フォールバック URL の af_id。未設定なら DMM_AFFILIATE_ID。
                              通常運用では使われない。
  - DATABASE_URL

使い方:
  cd apps/jobs
  python -m src.sync_catalog                       # デフォルト 100 件
  python -m src.sync_catalog --hits 50             # 1 フロア 50 件ずつ
  python -m src.sync_catalog --floors videoa       # 特定フロアだけ
  python -m src.sync_catalog --dry-run             # DB に書き込まずログだけ
"""
from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys
import unicodedata
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, AsyncIterator

import httpx
from aiolimiter import AsyncLimiter
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# apps/api を import パスに追加 (モデルを共有するため)
_REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO_ROOT / "apps" / "api"))

from app.db.models.actress import Actress  # noqa: E402
from app.db.models.genre import Genre  # noqa: E402
from app.db.models.goods import ActressGoods, Goods  # noqa: E402
from app.db.models.movie import Movie, MovieActress, MovieGenre  # noqa: E402
from app.db.models.series import Series  # noqa: E402


DMM_ENDPOINT = "https://api.dmm.com/affiliate/v3/ItemList"

# DMM API 呼び出しのグローバル rate limiter。
# - 旧実装: ページ間で time.sleep(1.0) していた (同期 sleep のため event loop そのものが止まる)
# - 新実装: aiolimiter のトークンバケットで "並列 floor 合計で 5 req/s" まで許可。
#   フロア/年を asyncio.gather で並列化しても DMM 側に多重 burst を掛けないように
#   全体で一本の limiter を共有する (module-global)。
#   DMM_API_RPS env で微調整可 (デフォルト 5)。
_DMM_API_RPS = float(os.getenv("DMM_API_RPS", "5") or 5)
# event loop ごとに AsyncLimiter を保持 (loop を跨ぐ re-use で RuntimeWarning が出るため)
_DMM_API_LIMITER: dict[asyncio.AbstractEventLoop, AsyncLimiter] = {}

# 旧コード互換用 (テスト・外部参照のため "1 req/s 相当のスリープ間隔" を残しておく)。
# 本体コードからは原則 _dmm_api_call() の limiter を使う。
RATE_LIMIT_SLEEP_SEC = 1.0


def _get_dmm_limiter() -> AsyncLimiter:
    """現在の event loop ごとに AsyncLimiter を 1 個保持する。

    AsyncLimiter は生成された event loop に紐づくので、
    複数 loop を跨ぐ (特に pytest) と警告が出るため loop id をキーにキャッシュする。
    """
    loop = asyncio.get_event_loop()
    limiter = _DMM_API_LIMITER.get(loop)
    if limiter is None:
        # max_rate トークン / 1 秒
        limiter = AsyncLimiter(max_rate=_DMM_API_RPS, time_period=1.0)
        _DMM_API_LIMITER[loop] = limiter
    return limiter


@asynccontextmanager
async def _dmm_api_call() -> AsyncIterator[None]:
    """DMM API コール 1 本に対して rate limit をかけるコンテキスト。"""
    async with _get_dmm_limiter():
        yield

# (site, service, floor, key_prefix)
# key_prefix は content_id のフォールバック識別子用
FLOORS: list[tuple[str, str, str, str]] = [
    ("FANZA", "digital", "videoa", "videoa"),  # 単体女優物 / ビデオ
    ("FANZA", "digital", "videoc", "videoc"),  # アマチュア
    ("FANZA", "mono",    "goods",  "goods"),   # 女優グッズ (現状 cron では取得しない)
]

# cron など floors 未指定時に取得するデフォルトフロア (動画のみ)
DEFAULT_FLOOR_NAMES: tuple[str, ...] = ("videoa", "videoc")

# floor → 購入ページ URL テンプレート (フォールバック専用)
# 通常は DMM API の `affiliateURL` (al.dmm.co.jp 経由のトラッキング付き) をそのまま使う。
# API が affiliateURL を返さなかった場合の最終フォールバックとしてのみ使用。
_AFFILIATE_URL_TEMPLATES: dict[str, str] = {
    "videoa": "https://www.dmm.co.jp/digital/videoa/-/detail/=/cid={cid}/?af_id={af_id}&ch=link_tool",
    "videoc": "https://www.dmm.co.jp/digital/videoc/-/detail/=/cid={cid}/?af_id={af_id}&ch=link_tool",
    "goods":  "https://www.dmm.co.jp/mono/goods/-/detail/=/cid={cid}/?af_id={af_id}&ch=link_tool",
}


def _build_affiliate_url(content_id: str, floor: str, affiliate_id: str) -> str:
    """floor に応じた DMM 購入ページ URL を組み立てる (フォールバック)。

    通常運用では DMM API の `affiliateURL` をそのまま使用する。
    API が `affiliateURL` を返さない (空 / null) ケースに限り、この関数で
    cid + af_id 直リンクを組み立てる。
    """
    tpl = _AFFILIATE_URL_TEMPLATES.get(floor)
    if tpl is None:
        # 未知の floor は videoa パターンにフォールバック
        tpl = _AFFILIATE_URL_TEMPLATES["videoa"]
    return tpl.format(cid=content_id, af_id=affiliate_id)


def _pick_affiliate_url(
    item: dict,
    content_id: str,
    floor: str,
    fallback_af_id: str,
) -> tuple[str, bool]:
    """DMM API レスポンスから affiliate URL を取り出す。

    DMM 側でクリックが正しくカウントされるよう、API が返した `affiliateURL`
    (camelCase) をそのまま使う。値が空・null の場合に限り
    `_build_affiliate_url` で組み立てたフォールバック URL を返す。

    :return: (url, used_api) — used_api=True なら API の affiliateURL を採用。
    """
    api_url = item.get("affiliateURL")
    if isinstance(api_url, str) and api_url.strip():
        return api_url.strip(), True
    fallback = _build_affiliate_url(content_id, floor, fallback_af_id)
    print(
        f"  [affiliate_url] fallback used cid={content_id} floor={floor}: "
        f"DMM API did not return affiliateURL"
    )
    return fallback, False


# ────────────────────────────────────────────────────────────
# ユーティリティ
# ────────────────────────────────────────────────────────────

def _get_async_url(url: str) -> str:
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return url


def _parse_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _parse_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_date(value: str | None) -> date | None:
    if not value:
        return None
    # DMM は "YYYY-MM-DD HH:MM:SS" や "YYYY-MM-DD" を返す
    s = str(value).strip().split(" ")[0]
    for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


_SLUG_RE = re.compile(r"[^a-z0-9\-]+")


def _slugify(s: str, fallback: str) -> str:
    """ASCII 化して slug を作る。日本語などはローマ字化せずハッシュ的に
    フォールバック識別子で安全な slug にする。

    同名で別 ID のレコード (例: シリーズ "NTR" が複数) で slug が衝突しないよう、
    fallback (content_id 等) を必ず suffix として付与してユニーク化する。
    """
    n = unicodedata.normalize("NFKD", s)
    n = n.encode("ascii", "ignore").decode("ascii").lower()
    n = _SLUG_RE.sub("-", n).strip("-")
    fb = _SLUG_RE.sub("-", fallback.lower()).strip("-") if fallback else ""
    if not n:
        # ASCII 化で空になった場合は fallback だけを使う
        return (fb or "item")[:80]
    # fallback (=content_id 等) が n と異なる場合のみ suffix として付与
    if fb and fb != n:
        return f"{n[:60]}-{fb}"[:80]
    return n[:80]


# ────────────────────────────────────────────────────────────
# DMM API 呼び出し
# ────────────────────────────────────────────────────────────

@dataclass
class FetchParams:
    api_id: str
    affiliate_id: str
    site: str
    service: str
    floor: str
    hits: int
    offset: int = 1
    sort: str = "date"
    # 期間スライス (全件取得時に offset の上限を回避するため)
    gte_date: str | None = None  # "YYYY-MM-DDT00:00:00"
    lte_date: str | None = None
    # 状態診断用 (トータル件数を見るときは hits=1, offset=1)
    article: str | None = None
    article_id: str | None = None


async def fetch_items_response(client: httpx.AsyncClient, fp: FetchParams) -> dict:
    """DMM ItemList API を叩いて result コンテナをそのまま返す。

    グローバル rate limiter (_get_dmm_limiter) を介して DMM 側へのリクエスト間隔を
    同一 event loop 上のすべての fetch で共有する。
    """
    params: dict[str, Any] = {
        "api_id": fp.api_id,
        "affiliate_id": fp.affiliate_id,
        "site": fp.site,
        "service": fp.service,
        "floor": fp.floor,
        "hits": fp.hits,
        "offset": fp.offset,
        "sort": fp.sort,
        "output": "json",
    }
    if fp.gte_date:
        params["gte_date"] = fp.gte_date
    if fp.lte_date:
        params["lte_date"] = fp.lte_date
    if fp.article:
        params["article"] = fp.article
    if fp.article_id:
        params["article_id"] = fp.article_id
    async with _dmm_api_call():
        res = await client.get(DMM_ENDPOINT, params=params, timeout=20)
    if res.status_code >= 400:
        # DMM は 4xx でも JSON でエラー詳細を返すので、それを見えるようにする
        body_snippet = res.text[:400]
        raise httpx.HTTPStatusError(
            f"HTTP {res.status_code} from DMM ItemList: {body_snippet}",
            request=res.request,
            response=res,
        )
    data = res.json()
    # 説明、ステータス、エラーも見えるようにデバッグログ
    result = data.get("result") or {}
    status = result.get("status")
    if status and status != 200:
        msg = result.get("message") or result.get("errors") or data
        raise RuntimeError(f"DMM API status={status}: {msg}")
    return result


async def fetch_items(client: httpx.AsyncClient, fp: FetchParams) -> list[dict]:
    result = await fetch_items_response(client, fp)
    return result.get("items") or []


# ────────────────────────────────────────────────────────────
# DMM Item を Movie に変換 / upsert
# ────────────────────────────────────────────────────────────

def _extract_price_list(item: dict) -> tuple[dict | None, int | None]:
    """prices.deliveries や price から price_list / price_min を作る。"""
    prices = item.get("prices") or {}
    deliveries = (prices.get("deliveries") or {}).get("delivery") or []

    list_price = _parse_int(prices.get("list_price"))
    sale_price = _parse_int(prices.get("price"))
    delivery_price = None
    rental_price = None

    for d in deliveries:
        dtype = d.get("type")
        p = _parse_int(d.get("price"))
        if dtype in ("stream", "download", "hd") and (delivery_price is None or (p is not None and p < delivery_price)):
            delivery_price = p
        if dtype in ("rental",) and (rental_price is None or (p is not None and p < rental_price)):
            rental_price = p

    pl = {
        "list_price": list_price,
        "sale_price": sale_price,
        "delivery_price": delivery_price,
        "rental_price": rental_price,
    }
    # 全部 None なら None にしてしまう
    if not any(v is not None for v in pl.values()):
        return None, None

    candidates = [v for v in (sale_price, delivery_price, rental_price, list_price) if v is not None]
    price_min = min(candidates) if candidates else None
    return pl, price_min


def _extract_review(item: dict) -> tuple[int, float | None]:
    review = item.get("review") or {}
    count = _parse_int(review.get("count")) or 0
    avg = _parse_float(review.get("average"))
    return count, avg


def _build_content_id(item: dict, floor_prefix: str) -> str:
    """DMM の content_id をそのまま使う。
    無ければ product_id / item_id にフォールバック。"""
    return (
        item.get("content_id")
        or item.get("product_id")
        or item.get("item_id")
        or f"{floor_prefix}-{uuid.uuid4()}"
    )


def _build_slug(item: dict, content_id: str) -> str:
    """slug は基本 content_id を流用 (英数記号で URL 安全)。"""
    return _slugify(content_id, content_id)


def _floor_image_base(floor: str) -> str:
    """DMM 画像 CDN のフロア別ベース URL。"""
    if floor == "videoa":
        return "https://pics.dmm.co.jp/digital/video"
    if floor == "videoc":
        return "https://pics.dmm.co.jp/digital/amateur"
    if floor == "goods":
        # mono サービスの goods (女優グッズ) は pics.dmm.co.jp/mono/goods/{cid}/{cid}pl.jpg
        return "https://pics.dmm.co.jp/mono/goods"
    # その他は digital/video を仮定 (見つからないときはフロント側 onError でさらに
    # fallback させる設計)
    return "https://pics.dmm.co.jp/digital/video"


def _build_list_image_url(content_id: str, floor: str) -> str | None:
    """一覧ページ用サムネイル URL を組み立てる。

    フロア別に画像 CDN に登録されている suffix が異なる:
      - videoa (プロ作品): `pl.jpg` (800x538 見開きジャケット) を使う。
               CSS 側で `object-position: right center` を指定してメイン画像側
               (右半分) をクロップ表示し表ジャケット部分を除去する。
      - videoc (素人): `pl.jpg` は 存在せず now_printing にリダイレクトされるため
               `jp.jpg` (300x300) を使う (`jm.jpg` 100x100 は小さすぎる)
      - goods (女優グッズ): `pl.jpg` (パッケージ画像) を使う。
               mono/goods/{cid}/{cid}pl.jpg が CDN 上の正規の画像。
    """
    cid = (content_id or "").strip().lower()
    if not cid:
        return None
    if floor == "videoc":
        return f"{_floor_image_base(floor)}/{cid}/{cid}jp.jpg"
    # videoa / goods は pl.jpg を使う。videoa は CSS で右クロップ、
    # goods はパッケージ全体をそのまま見せる。
    return f"{_floor_image_base(floor)}/{cid}/{cid}pl.jpg"


def _build_large_image_url(content_id: str, floor: str) -> str | None:
    """フィード・詳細ページ用の高解像度画像 URL を組み立てる。

    フロア別に画像 CDN に登録されている suffix が異なる:
      - videoa: `pl.jpg` (800x590) が存在する
      - videoc: `pl.jpg` は **存在せず** now_printing にリダイレクトされる。
               サンプル画像 `jp-001.jpg` (711x800) を使うのが最も鮮明
      - goods: `pl.jpg` がパッケージ高解像度画像。
    """
    cid = (content_id or "").strip().lower()
    if not cid:
        return None
    if floor == "videoc":
        return f"{_floor_image_base(floor)}/{cid}/{cid}jp-001.jpg"
    return f"{_floor_image_base(floor)}/{cid}/{cid}pl.jpg"


_GOODS_PL_SUFFIX_RE = re.compile(r"(p[tsm])\.jpg$", re.IGNORECASE)


def _upgrade_goods_image_to_pl(url: str | None) -> str | None:
    """goods 用: API が返す `..._pt.jpg` / `..._ps.jpg` / `..._jm.jpg` URL を `..._pl.jpg` に置換する。

    DMM API は goods の imageURL.list / small には pt.jpg / ps.jpg を返すが、
    imageURL.large は欠ける商品が多い。一方、同じパスの pl.jpg は CDN 上に
    存在することがほとんどなので、ファイル名末尾の suffix だけ差し替えて
    大画像 URL を生成する。
    マッチしない URL (パターン外) は None を返し、呼び出し側で fallback させる。
    """
    if not url:
        return None
    new_url, n = _GOODS_PL_SUFFIX_RE.subn("pl.jpg", url)
    return new_url if n > 0 else None


# pl.jpg の存在確認キャッシュ: 同一 URL の HEAD リクエストを重複させない
# True=実在 (200), False=不在 (404 or now_printing にリダイレクト)
_PL_EXISTS_CACHE: dict[str, bool] = {}


async def _pl_image_exists(client: httpx.AsyncClient, url: str) -> bool:
    """pl.jpg URL が実際にサーバー上に存在するか HEAD リクエストで確認する。

    DMM CDN は存在しない商品画像についても HTTP 200 を返しつつ、`now_printing.jpg`
    に 30x リダイレクトさせる。そのため、follow_redirects=True で最終 URL に
    `now_printing` が含まれているかも判定する。
    """
    if not url:
        return False
    cached = _PL_EXISTS_CACHE.get(url)
    if cached is not None:
        return cached
    try:
        resp = await client.head(url, timeout=5, follow_redirects=True)
        ok = (
            resp.status_code == 200
            and "now_printing" not in str(resp.url).lower()
        )
    except httpx.HTTPError:
        ok = False
    _PL_EXISTS_CACHE[url] = ok
    return ok


@dataclass
class UpsertCounters:
    inserted: int = 0
    updated: int = 0
    skipped: int = 0
    errors: int = 0


# ────────────────────────────────────────────────────────────
# Genre / Actress プロセス内キャッシュ (N+1 SELECT 除去用)
# ────────────────────────────────────────────────────────────
#
# 旧実装では作品 1 件 upsert するたびに:
#   - _sync_genres: SELECT Genre, SELECT MovieGenre (x ジャンル数) を毎回発行
#   - _sync_actresses: 女優 1 件ごとに SELECT Actress (content_id), SELECT Actress (name), SELECT MovieActress
# と N+1 が豊富に発生していた。Railway Private Network でも
# 累計 RTT が伸びるため、ジョブ起動時に 1 回だけ SELECT して in-memory 辞書に
# 保持し、以降は作品ごとのチェックをすべてメモリ内で済ませる。


@dataclass
class GenreCache:
    """Genre.name → Genre (主キー id) の in-memory キャッシュ。"""

    by_name: dict[str, Genre] = field(default_factory=dict)
    warmed: bool = False

    async def warm(self, session: AsyncSession) -> None:
        if self.warmed:
            return
        rows = (await session.execute(select(Genre))).scalars().all()
        self.by_name = {g.name: g for g in rows if g.name}
        self.warmed = True

    async def get_or_create(self, session: AsyncSession, name: str) -> Genre:
        g = self.by_name.get(name)
        if g is not None:
            return g
        g = Genre(name=name)
        session.add(g)
        # id を付与させるため flush。INSERT 本体はトランザクション末尾の commit でまとめて送信される。
        await session.flush()
        self.by_name[name] = g
        return g


@dataclass
class ActressCache:
    """Actress を content_id / name 両方で引ける in-memory キャッシュ。

    content_id (DMM 側 ID) があればそちらを主キー、無ければ name をフォールバックキーにする。
    ジョブ初期化時に一括 SELECT して保持し、以降の女優リンク付けで SELECT を走らせない。
    """

    by_content_id: dict[str, Actress] = field(default_factory=dict)
    by_name: dict[str, Actress] = field(default_factory=dict)
    warmed: bool = False

    async def warm(self, session: AsyncSession) -> None:
        if self.warmed:
            return
        rows = (await session.execute(select(Actress))).scalars().all()
        for a in rows:
            if a.content_id:
                self.by_content_id[a.content_id] = a
            if a.name:
                # 同名異人がいるケースは content_id 側のルックアップを優先させるため、
                # by_name は「同名で上書き」してもよい (識別可能な content_id があるときは
                # by_content_id 側を見るため衰退見られで不具合にはならない)。
                self.by_name[a.name] = a
        self.warmed = True

    async def get_or_create(
        self,
        session: AsyncSession,
        *,
        content_id: str | None,
        name: str,
        ruby: str | None = None,
        slug: str | None = None,
    ) -> Actress:
        # content_id を優先、無ければ name で引く
        actress: Actress | None = None
        if content_id:
            actress = self.by_content_id.get(content_id)
        if actress is None:
            actress = self.by_name.get(name)
        if actress is not None:
            # 補完 (content_id / ruby が後から判明したケース)
            if content_id and not actress.content_id:
                actress.content_id = content_id
                self.by_content_id[content_id] = actress
            if ruby and not actress.ruby:
                actress.ruby = ruby
            return actress
        # 新規作成
        actress = Actress(
            content_id=content_id,
            name=name,
            slug=slug or _slugify(name, content_id or name),
            ruby=ruby,
        )
        session.add(actress)
        await session.flush()
        if content_id:
            self.by_content_id[content_id] = actress
        if name:
            self.by_name[name] = actress
        return actress

    def names(self) -> set[str]:
        """DB 上の女優名集合を返す (goods フィルタ用)。"""
        return set(self.by_name.keys())


@dataclass
class MovieLinkCache:
    """作品 (movie_id) ごとのジャンル / 女優リンク集合をメモリ上に保持するキャッシュ。

    初めてその movie_id を見たときにだけ SELECT し、以降は全てメモリで判定する。
    同一 movie を batch 内で複数回触ることはないが、 idempotent に作っておくと
    スキーマ変更時のリストリックも安全。
    """

    genres: dict[str, set[str]] = field(default_factory=dict)      # movie_id -> set(genre_id)
    actresses: dict[str, set[str]] = field(default_factory=dict)  # movie_id -> set(actress_id)

    async def get_genre_ids(self, session: AsyncSession, movie_id: str) -> set[str]:
        cached = self.genres.get(movie_id)
        if cached is not None:
            return cached
        rows = (
            await session.execute(
                select(MovieGenre.genre_id).where(MovieGenre.movie_id == movie_id)
            )
        ).scalars().all()
        s = set(rows)
        self.genres[movie_id] = s
        return s

    async def get_actress_ids(self, session: AsyncSession, movie_id: str) -> set[str]:
        cached = self.actresses.get(movie_id)
        if cached is not None:
            return cached
        rows = (
            await session.execute(
                select(MovieActress.actress_id).where(MovieActress.movie_id == movie_id)
            )
        ).scalars().all()
        s = set(rows)
        self.actresses[movie_id] = s
        return s


async def upsert_movie(
    session: AsyncSession,
    item: dict,
    floor_prefix: str,
    counters: UpsertCounters,
    *,
    affiliate_id: str,
    floor: str,
    dry_run: bool = False,
    actress_filter: set[str] | None = None,
    http_client: httpx.AsyncClient | None = None,
    genre_cache: GenreCache | None = None,
    actress_cache: ActressCache | None = None,
    link_cache: MovieLinkCache | None = None,
) -> None:
    """DMM API の 1 件を Movie テーブルに upsert する。

    MP4 直リンク (旧 sample_movie_url) は DB に保持しない設計に変更済み。
    再生時に apps/api 側の resolve-mp4 endpoint が in-process httpx で都度抽出する。

    :param actress_filter:
        与えられたとき、作品に含まれる女優名がこのセットに 1 つも一致しなければ skip。
        goods フロアで DB に存在する女優に関連する商品だけ保存するために使う。

    :param genre_cache: ジャンル名→id の in-memory キャッシュ。None なら逆互換パスで SELECT する。
    :param actress_cache: 女優キャッシュ。
    :param link_cache: movie ごとのリンク集合キャッシュ。
    """
    # goods フロアは Movie ではなく Goods テーブルに振り分ける
    if floor == "goods":
        await upsert_goods(
            session,
            item,
            floor_prefix,
            counters,
            affiliate_id=affiliate_id,
            dry_run=dry_run,
            actress_filter=actress_filter,
            http_client=http_client,
            actress_cache=actress_cache,
        )
        return

    content_id = _build_content_id(item, floor_prefix)
    iteminfo = item.get("iteminfo") or {}

    # goods フロア以外でも使えるフィルタ: DB にいる女優と関連している作品だけ保存する。
    if actress_filter is not None:
        actresses_arr = iteminfo.get("actress") or []
        names_in_item = [a.get("name") for a in actresses_arr if isinstance(a, dict) and a.get("name")]
        if not any(n in actress_filter for n in names_in_item):
            counters.skipped += 1
            return

    image_urls = item.get("imageURL") or {}
    sample_movie = (item.get("sampleMovieURL") or {})
    sample_image = (item.get("sampleImageURL") or {})

    # iframe プレイヤー URL は「サンプル動画あり」の存在チェックに使う。
    # MP4 直リンクは apps/api 側 (resolve-mp4 endpoint / extractor) が
    # ユーザー初回再生時に動的に解決して DB に書き戻すため、ここでは推測しない。
    sample_embed_url = (
        sample_movie.get("size_720_480")
        or sample_movie.get("size_644_414")
        or sample_movie.get("size_560_360")
    )

    # 動画 floor (videoa/videoc) で API が sample (iframe URL) を返さない
    # ものは「サンプル動画なし」とみなして取り扱わない。
    # MP4 直リンクは content_id から機械的に生成できるが、API が sample を
    # 返さない作品は実際の動画ファイルも存在しないことが多い。
    if floor in ("videoa", "videoc") and not sample_embed_url:
        counters.skipped += 1
        return

    # 既存チェック
    existing = (
        await session.execute(select(Movie).where(Movie.content_id == content_id))
    ).scalar_one_or_none()

    title = item.get("title") or item.get("name") or "(無題)"
    slug = existing.slug if existing else _build_slug(item, content_id)

    # DMM API の affiliateURL をそのまま使う (DMM 側のクリック計測を保つため)。
    # API が返さない場合に限り cid + af_id の直リンクへフォールバック。
    affiliate_url, _aff_from_api = _pick_affiliate_url(item, content_id, floor, affiliate_id)
    # mobile (SP) 用のトラッキング URL は API レスポンスの `affiliateURL_mobile`
    # (または旧名 `affiliateURLs_mobile`) を優先する。
    affiliate_url_mobile = (
        item.get("affiliateURL_mobile")
        or item.get("affiliateURLs_mobile")
    )

    price_list, price_min = _extract_price_list(item)
    review_count, review_avg = _extract_review(item)

    # 制作者情報 (リストになる場合があるので最初の 1 件)
    # DMM API は「メーカー / レーベル未設定」を表すプレースホルダとして
    # name="----" あるいは空文字列を返してくることがある (例: 1sun00055a の label)。
    # それをそのまま保存すると UI で「レーベル: ----」と表示されてしまうため、None に正規化する。
    def _first_name(key: str) -> str | None:
        arr = iteminfo.get(key) or []
        if isinstance(arr, list) and arr:
            name = arr[0].get("name")
            if name is None:
                return None
            s = str(name).strip()
            if not s or s == "----":
                return None
            return s
        return None

    director_name = _first_name("director")
    maker_name = _first_name("maker")
    label_name = _first_name("label")

    # 日付
    release_date = _parse_date(item.get("date"))
    delivery_date = release_date  # FANZA digital では date が配信開始日
    primary_date = delivery_date or release_date

    # シリーズ
    series_obj = None
    series_arr = iteminfo.get("series") or []
    if isinstance(series_arr, list) and series_arr:
        s = series_arr[0]
        s_content_id = str(s.get("id")) if s.get("id") is not None else None
        s_name = s.get("name")
        if s_content_id and s_name:
            series_obj = (
                await session.execute(
                    select(Series).where(Series.content_id == s_content_id)
                )
            ).scalar_one_or_none()
            if not series_obj:
                series_obj = Series(
                    id=str(uuid.uuid4()),
                    content_id=s_content_id,
                    name=s_name,
                    slug=_slugify(s_name, s_content_id),
                )
                if not dry_run:
                    session.add(series_obj)
                    await session.flush()

    if existing:
        movie = existing
        movie.title = title
        movie.description = item.get("comment") or movie.description or ""
        movie.volume = _parse_int(item.get("volume"))
        # サムネイル (一覧・フィード用) は ps.jpg (147x200) を使う。
        # API の imageURL.list は pt.jpg/jm.jpg になり画質が悪いため自前生成を優先。
        new_image_list = _build_list_image_url(content_id, floor) or image_urls.get("list")
        # 詳細ページ用の高解像度画像は pl.jpg (800x590)。API が返さないケースも
        # content_id から URL を生成して補う。
        new_image_large = image_urls.get("large") or _build_large_image_url(content_id, floor)
        movie.image_url_list = new_image_list or movie.image_url_list
        movie.image_url_large = new_image_large or movie.image_url_large
        movie.sample_embed_url = sample_embed_url or movie.sample_embed_url
        # affiliate_url の更新ルール:
        #   - API が affiliateURL を返した場合 → そのまま上書き
        #     (DMM 側のクリック計測を保つため自前 URL からの移行も兼ねる)
        #   - API が返さなかった場合 → 既存値があれば触らず、空のときだけフォールバックを書く
        if _aff_from_api:
            movie.affiliate_url = affiliate_url
        elif not movie.affiliate_url:
            movie.affiliate_url = affiliate_url
        movie.affiliate_url_en = affiliate_url_mobile or movie.affiliate_url_en
        movie.price_list = price_list or movie.price_list
        movie.price_min = price_min if price_min is not None else movie.price_min
        movie.release_date = release_date or movie.release_date
        movie.delivery_date = delivery_date or movie.delivery_date
        movie.primary_date = primary_date or movie.primary_date
        movie.review_count = max(review_count, movie.review_count or 0)
        movie.review_average = review_avg if review_avg is not None else movie.review_average
        movie.director_name = director_name or movie.director_name
        movie.label_name = label_name or movie.label_name
        movie.maker_name = maker_name or movie.maker_name
        movie.product_id = item.get("product_id") or movie.product_id
        movie.maker_product = item.get("maker_product") or movie.maker_product
        if series_obj:
            movie.series_id = series_obj.id
        counters.updated += 1
    else:
        movie = Movie(
            id=str(uuid.uuid4()),
            content_id=content_id,
            product_id=item.get("product_id"),
            maker_product=item.get("maker_product"),
            title=title,
            slug=slug,
            description=item.get("comment") or "",
            volume=_parse_int(item.get("volume")),
            image_url_list=(
                _build_list_image_url(content_id, floor)
                or image_urls.get("list")
            ),
            image_url_large=(
                image_urls.get("large")
                or _build_large_image_url(content_id, floor)
            ),
            sample_embed_url=sample_embed_url,
            affiliate_url=affiliate_url,
            affiliate_url_en=affiliate_url_mobile,
            price_list=price_list,
            price_min=price_min,
            release_date=release_date,
            delivery_date=delivery_date,
            primary_date=primary_date,
            review_count=review_count,
            review_average=review_avg,
            director_name=director_name,
            label_name=label_name,
            maker_name=maker_name,
            series_id=series_obj.id if series_obj else None,
            is_visible=True,
        )
        if not dry_run:
            session.add(movie)
            await session.flush()
        counters.inserted += 1

    # ジャンル
    # DMM API の iteminfo.genre に加えて、フロア別の擬似ジャンルを付与する。
    # videoa (プロ作品) -> 「プロ女優」
    # videoc (素人作品) -> 「アマチュア」 (DMM 既存ジャンル「素人」と衢突しないよう)
    # これによりフロント側で floor を意識せずにジャンルチップだけで絞り込める。
    genres_arr = iteminfo.get("genre") or []
    genre_names = [g.get("name") for g in genres_arr if isinstance(g, dict) and g.get("name")]
    floor_genre = _floor_genre_label(floor)
    if floor_genre and floor_genre not in genre_names:
        genre_names.append(floor_genre)
    if genre_names and not dry_run:
        await _sync_genres(
            session, movie.id, genre_names,
            genre_cache=genre_cache, link_cache=link_cache,
        )

    # 女優
    actresses_arr = iteminfo.get("actress") or []
    if isinstance(actresses_arr, list) and actresses_arr and not dry_run:
        await _sync_actresses(
            session, movie.id, actresses_arr,
            actress_cache=actress_cache, link_cache=link_cache,
        )


def _floor_genre_label(floor: str) -> str | None:
    """フロア名から UI 表示用の擬似ジャンル名を返す。

    「アマチュア」としているのは、DMM が本来付けるジャンル「素人」と被らせないため。
    """
    if floor == "videoa":
        return "プロ女優"
    if floor == "videoc":
        return "アマチュア"
    return None


async def _sync_genres(
    session: AsyncSession,
    movie_id: str,
    names: list[str],
    *,
    genre_cache: GenreCache | None = None,
    link_cache: MovieLinkCache | None = None,
) -> None:
    """作品とジャンルのリンクを同期する。

    genre_cache / link_cache が与えられたら in-memory で判定して SELECT を適用外にする。
    両者が None のときは旧動作 (作品ごとに SELECT) にフォールバックして安全に動く。
    """
    if not names:
        return

    # ジャンルオブジェクトの解決
    name_to_genre: dict[str, Genre]
    if genre_cache is not None:
        name_to_genre = {}
        for name in names:
            name_to_genre[name] = await genre_cache.get_or_create(session, name)
    else:
        existing_genres = (
            await session.execute(select(Genre).where(Genre.name.in_(names)))
        ).scalars().all()
        name_to_genre = {g.name: g for g in existing_genres}
        for name in names:
            if name not in name_to_genre:
                g = Genre(name=name)
                session.add(g)
                await session.flush()
                name_to_genre[name] = g

    # 既存リンクの解決
    if link_cache is not None:
        linked_ids = await link_cache.get_genre_ids(session, movie_id)
    else:
        existing_links = (
            await session.execute(
                select(MovieGenre.genre_id).where(MovieGenre.movie_id == movie_id)
            )
        ).scalars().all()
        linked_ids = set(existing_links)

    for name in names:
        g = name_to_genre[name]
        if g.id not in linked_ids:
            session.add(MovieGenre(movie_id=movie_id, genre_id=g.id))
            linked_ids.add(g.id)


# ───────────────────────────────────────────────────────────
# Goods (女優グッズ) upsert
# ───────────────────────────────────────────────────────────

async def upsert_goods(
    session: AsyncSession,
    item: dict,
    floor_prefix: str,
    counters: UpsertCounters,
    *,
    affiliate_id: str,
    dry_run: bool = False,
    actress_filter: set[str] | None = None,
    http_client: httpx.AsyncClient | None = None,
    actress_cache: ActressCache | None = None,
) -> None:
    """DMM goods フロアの 1 件を Goods テーブルに upsert する。

    Movie とは独立したテーブルに保存し、女優詳細ページの「関連商品」セクションでだけ
    参照する。sample_embed_url / director / series はない。

    actress_filter が与えられたとき、商品に含まれる女優名がセットに 1 つも一致しなければ skip。
    さらに、一致した女優だけを ActressGoods リンクに追加する (新規女優はここでは追加しない)。
    """
    iteminfo = item.get("iteminfo") or {}

    # 商品に関連する女優名を抽出
    actresses_arr = iteminfo.get("actress") or []
    actress_names = [
        a.get("name") for a in actresses_arr
        if isinstance(a, dict) and a.get("name")
    ]

    # DB 女優フィルタ: 1 つも一致しない商品は保存しない
    if actress_filter is not None:
        matched_names = [n for n in actress_names if n in actress_filter]
        if not matched_names:
            counters.skipped += 1
            return
    else:
        matched_names = actress_names

    content_id = _build_content_id(item, floor_prefix)
    image_urls = item.get("imageURL") or {}

    title = item.get("title") or item.get("name") or "(無題)"
    # DMM API の affiliateURL を優先採用 (なければ goods 用フォールバック)。
    affiliate_url, _aff_from_api = _pick_affiliate_url(item, content_id, "goods", affiliate_id)
    price_list, price_min = _extract_price_list(item)
    review_count, review_avg = _extract_review(item)

    def _first_name(key: str) -> str | None:
        arr = iteminfo.get(key) or []
        if isinstance(arr, list) and arr:
            return arr[0].get("name")
        return None

    maker_name = _first_name("maker")
    label_name = _first_name("label")

    release_date = _parse_date(item.get("date"))
    primary_date = release_date

    existing = (
        await session.execute(select(Goods).where(Goods.content_id == content_id))
    ).scalar_one_or_none()

    # goods の画像 URL 選定:
    #   1. API が imageURL.large を返していたらそれを使う
    #   2. そうでなければ pt.jpg/ps.jpg パスから pl.jpg URL を生成し、HEAD で実在確認
    #      (CDN は欠けている画像を now_printing.jpg にリダイレクトするため、遷移後 URL も見る)
    #   3. それもダメなら imageURL.small (ps.jpg) 、最後に list (pt.jpg) に fallback
    api_list = image_urls.get("list") or image_urls.get("small")
    api_small = image_urls.get("small") or api_list
    new_image_list = api_list

    new_image_large: str | None = image_urls.get("large")
    if not new_image_large:
        candidate_pl = _upgrade_goods_image_to_pl(api_list)
        if candidate_pl and http_client is not None:
            if await _pl_image_exists(http_client, candidate_pl):
                new_image_large = candidate_pl
            else:
                # pl.jpg が不在 → small (ps.jpg) に fallback
                new_image_large = api_small
        else:
            # http_client がない (テスト等) やパターン外: 以前と同じ振る舞いで pl.jpg をそのまま採用
            new_image_large = candidate_pl or api_small or api_list
    # 調査用ログ: 最初の 3 件だけ API が返す imageURL の生データを出す
    if counters.inserted + counters.updated < 3:
        print(
            f"  [goods debug] cid={content_id} "
            f"imageURL.list={image_urls.get('list')!r} "
            f"imageURL.large={image_urls.get('large')!r} "
            f"imageURL.small={image_urls.get('small')!r}"
        )

    if existing:
        goods = existing
        goods.title = title
        goods.description = item.get("comment") or goods.description or ""
        goods.image_url_list = new_image_list or goods.image_url_list
        goods.image_url_large = new_image_large or goods.image_url_large
        # affiliate_url: API が affiliateURL を返したら常に上書き、
        # 返さなかった場合は既存値を保ち空のときだけフォールバックを書く。
        if _aff_from_api:
            goods.affiliate_url = affiliate_url
        elif not goods.affiliate_url:
            goods.affiliate_url = affiliate_url
        goods.price_list = price_list or goods.price_list
        goods.price_min = price_min if price_min is not None else goods.price_min
        goods.release_date = release_date or goods.release_date
        goods.primary_date = primary_date or goods.primary_date
        goods.review_count = max(review_count, goods.review_count or 0)
        goods.review_average = (
            review_avg if review_avg is not None else goods.review_average
        )
        goods.maker_name = maker_name or goods.maker_name
        goods.label_name = label_name or goods.label_name
        goods.product_id = item.get("product_id") or goods.product_id
        counters.updated += 1
    else:
        slug = _build_slug(item, content_id)
        goods = Goods(
            id=str(uuid.uuid4()),
            content_id=content_id,
            product_id=item.get("product_id"),
            title=title,
            slug=slug,
            description=item.get("comment") or "",
            image_url_list=new_image_list,
            image_url_large=new_image_large,
            affiliate_url=affiliate_url,
            price_list=price_list,
            price_min=price_min,
            release_date=release_date,
            primary_date=primary_date,
            review_count=review_count,
            review_average=review_avg,
            maker_name=maker_name,
            label_name=label_name,
            is_visible=True,
        )
        if not dry_run:
            session.add(goods)
            await session.flush()
        counters.inserted += 1

    # 女優リンク (既存女優だけ): DB を見て actress_filter に一致した名前の女優を探す
    if not dry_run and matched_names:
        await _link_goods_actresses(
            session, goods.id, matched_names, actress_cache=actress_cache
        )


async def _link_goods_actresses(
    session: AsyncSession,
    goods_id: str,
    actress_names: list[str],
    *,
    actress_cache: ActressCache | None = None,
) -> None:
    """商品と (既存) 女優の多対多リンクを設定する。未登録女優はここでは作らない。

    actress_cache を与えれば in-memory で名前→Actress を解決して SELECT を省く。
    """
    if not actress_names:
        return

    # Actress レコードを解決
    if actress_cache is not None:
        actresses = [
            a for a in (actress_cache.by_name.get(n) for n in actress_names) if a is not None
        ]
    else:
        actresses = (
            await session.execute(
                select(Actress).where(Actress.name.in_(actress_names))
            )
        ).scalars().all()
    if not actresses:
        return

    # ActressGoods の既存リンクは goods 1 件ごとに見るしかないため SELECT はそのまま (1 本)。
    # goods は "新規 insert か、同じ cid に同じ actress を link した状態" のどちらかなので
    # リンク集合キャッシュも適用しにくいためさわらない。
    existing_links = (
        await session.execute(
            select(ActressGoods.actress_id).where(ActressGoods.goods_id == goods_id)
        )
    ).scalars().all()
    linked_ids = set(existing_links)
    for pos, actress in enumerate(actresses):
        if actress.id not in linked_ids:
            session.add(
                ActressGoods(goods_id=goods_id, actress_id=actress.id, position=pos)
            )
            linked_ids.add(actress.id)


async def _sync_actresses(
    session: AsyncSession,
    movie_id: str,
    actress_items: list[dict],
    *,
    actress_cache: ActressCache | None = None,
    link_cache: MovieLinkCache | None = None,
) -> None:
    """作品と女優のリンクを同期する。

    actress_cache / link_cache が与えられたら in-memory ですべて解決して SELECT を省く。
    """
    if not actress_items:
        return

    # 作品の既存女優リンク (movie_id -> set(actress_id))
    if link_cache is not None:
        linked_ids = await link_cache.get_actress_ids(session, movie_id)
    else:
        existing = (
            await session.execute(
                select(MovieActress.actress_id).where(MovieActress.movie_id == movie_id)
            )
        ).scalars().all()
        linked_ids = set(existing)

    for pos, a in enumerate(actress_items):
        a_cid = str(a.get("id")) if a.get("id") is not None else None
        a_name = a.get("name")
        if not a_name:
            continue

        if actress_cache is not None:
            actress = await actress_cache.get_or_create(
                session,
                content_id=a_cid,
                name=a_name,
                ruby=a.get("ruby"),
            )
        else:
            actress = None
            if a_cid:
                actress = (
                    await session.execute(
                        select(Actress).where(Actress.content_id == a_cid)
                    )
                ).scalar_one_or_none()
            if actress is None:
                actress = (
                    await session.execute(
                        select(Actress).where(Actress.name == a_name)
                    )
                ).scalar_one_or_none()
            if actress is None:
                actress = Actress(
                    content_id=a_cid,
                    name=a_name,
                    slug=_slugify(a_name, a_cid or a_name),
                    ruby=a.get("ruby"),
                )
                session.add(actress)
                await session.flush()
            else:
                if a_cid and not actress.content_id:
                    actress.content_id = a_cid
                if a.get("ruby") and not actress.ruby:
                    actress.ruby = a.get("ruby")

        # リンク追加 (既にあるなら noop)
        if actress.id not in linked_ids:
            session.add(MovieActress(movie_id=movie_id, actress_id=actress.id, position=pos))
            linked_ids.add(actress.id)


# ────────────────────────────────────────────────────────────
# 期間スライス生成 (全件取得用)
# ────────────────────────────────────────────────────────────

def _month_slices(start: date, end: date) -> list[tuple[str, str]]:
    """start から end までを月単位にスライスして、
    (gte_date, lte_date) のリストを ISO 形式で返す。

    DMM ItemList API は offset が 50000 までの制限があるため、
    全件取得するときは gte_date/lte_date で期間を区切って取る。
    月単位 × 1 スライスあたり最大5万件までカバーする計算。
    """
    slices: list[tuple[str, str]] = []
    # 月の初日に揃える
    cursor = date(start.year, start.month, 1)
    while cursor <= end:
        # その月の末日 = 翼月の初日 - 1 日
        if cursor.month == 12:
            next_month = date(cursor.year + 1, 1, 1)
        else:
            next_month = date(cursor.year, cursor.month + 1, 1)
        month_end = min(end, next_month - timedelta(days=1))
        gte = cursor.isoformat() + "T00:00:00"
        lte = month_end.isoformat() + "T23:59:59"
        slices.append((gte, lte))
        cursor = next_month
    return slices


# ────────────────────────────────────────────────────────────
# メイン処理
# ────────────────────────────────────────────────────────────

async def _process_items(
    session: AsyncSession,
    items: list[dict],
    *,
    prefix: str,
    counters: UpsertCounters,
    affiliate_id: str,
    floor: str,
    dry_run: bool,
    actress_filter: set[str] | None,
    http_client: httpx.AsyncClient | None = None,
    genre_cache: GenreCache | None = None,
    actress_cache: ActressCache | None = None,
    link_cache: MovieLinkCache | None = None,
) -> None:
    """取得した items リストを batch ごとに upsert して 1 回だけコミットする。

    旧実装は items ごとに `await session.commit()` を走らせていたため、
    100 件バッチ × 年×月スライスで commit RTT が累計重かった。
    新実装は以下の設計:

      - 1 バッチ (= 1 API ページ、最大 100 件) を 1 つのトランザクションとして処理
      - 1 件ごとに SAVEPOINT (begin_nested) を見てスコープを作るので、
        1 件 INSERT で失敗してもその件だけ ROLLBACK され、他の件は生きる
      - バッチ末尾で一括 commit (RTT 100 倍 → 1 倍)

    キャッシュ (genre/actress/link) を受け取り、N+1 SELECT も合わせて除去した上で
    1 バッチあたりの DB ラウンドトリップを大幅に削減する。
    """
    if not items:
        return

    if dry_run:
        # dry_run は DB に書かずロジックだけ走らせる (カウンタ件数を見るため)
        for item in items:
            try:
                await upsert_movie(
                    session,
                    item,
                    prefix,
                    counters,
                    affiliate_id=affiliate_id,
                    floor=floor,
                    dry_run=True,
                    actress_filter=actress_filter,
                    http_client=http_client,
                    genre_cache=genre_cache,
                    actress_cache=actress_cache,
                    link_cache=link_cache,
                )
            except Exception as e:  # noqa: BLE001
                print(f"    [ERROR][dry-run] upsert failed cid={item.get('content_id')}: {e}")
                counters.errors += 1
        return

    # 本番モード: 1 バッチ 1 トランザクション、件ごと SAVEPOINT
    try:
        async with session.begin():
            for item in items:
                try:
                    async with session.begin_nested():  # SAVEPOINT
                        await upsert_movie(
                            session,
                            item,
                            prefix,
                            counters,
                            affiliate_id=affiliate_id,
                            floor=floor,
                            dry_run=False,
                            actress_filter=actress_filter,
                            http_client=http_client,
                            genre_cache=genre_cache,
                            actress_cache=actress_cache,
                            link_cache=link_cache,
                        )
                except Exception as e:  # noqa: BLE001
                    # SAVEPOINT ロールバックは begin_nested の __aexit__ で処理済み
                    print(f"    [ERROR] upsert failed cid={item.get('content_id')}: {e}")
                    counters.errors += 1
        # ここで session.begin() の __aexit__ で commit が走る
    except Exception as outer:  # noqa: BLE001
        # トランザクション末尾の commit そのものが失敗 (DB 切断等)
        print(f"    [ERROR] batch commit failed floor={floor}: {outer}")
        counters.errors += len(items)
        try:
            await session.rollback()
        except Exception:  # noqa: BLE001
            pass


async def _run_floor_window(
    *,
    client: httpx.AsyncClient,
    session: AsyncSession,
    api_id: str,
    api_affiliate_id: str,
    link_affiliate_id: str,
    site: str,
    service: str,
    floor: str,
    prefix: str,
    hits_limit: int | None,
    gte_date: str | None,
    lte_date: str | None,
    counters: UpsertCounters,
    dry_run: bool,
    actress_filter: set[str] | None,
    genre_cache: GenreCache | None = None,
    actress_cache: ActressCache | None = None,
    link_cache: MovieLinkCache | None = None,
) -> None:
    """一つの (floor, 期間ウィンドウ) を offset でページングして全件取得し、upsert する。

    :param hits_limit:
        上限件数。未指定 (None) のときは API が返すだけ取り切る (全件モード)。

    ページ間の rate limit は fetch_items_response 内部のグローバル AsyncLimiter が
    ケアするため、ここで sleep はしない。
    """
    fetched = 0
    offset = 1
    # DMM API の offset 上限 (50000) を超えないようガード
    MAX_OFFSET = 50000
    while True:
        if hits_limit is not None and fetched >= hits_limit:
            break
        if offset > MAX_OFFSET:
            print(f"  [{floor}] reached offset limit ({MAX_OFFSET}), stopping this window")
            break
        # 1 回のリクエストで取る件数
        if hits_limit is None:
            batch_size = 100
        else:
            batch_size = min(100, hits_limit - fetched)
        fp = FetchParams(
            api_id=api_id,
            affiliate_id=api_affiliate_id,
            site=site,
            service=service,
            floor=floor,
            hits=batch_size,
            offset=offset,
            gte_date=gte_date,
            lte_date=lte_date,
        )
        try:
            items = await fetch_items(client, fp)
        except (httpx.HTTPError, RuntimeError) as e:
            print(f"  [ERROR] {floor} offset={offset}: {e}")
            counters.errors += 1
            break
        if not items:
            print(f"  [{floor}] no more items (offset={offset})")
            break
        window = f" {gte_date[:10]}–{lte_date[:10]}" if gte_date and lte_date else ""
        print(f"  [{floor}]{window} offset={offset} got {len(items)} items")
        await _process_items(
            session,
            items,
            prefix=prefix,
            counters=counters,
            affiliate_id=link_affiliate_id,
            floor=floor,
            dry_run=dry_run,
            actress_filter=actress_filter,
            http_client=client,
            genre_cache=genre_cache,
            actress_cache=actress_cache,
            link_cache=link_cache,
        )
        fetched += len(items)
        offset += len(items)
        if len(items) < batch_size:
            break
        # ページ間の sleep は不要 (AsyncLimiter が rate をケア)


async def _load_db_actress_names(session: AsyncSession) -> set[str]:
    """DB に現在登録されている全女優の名前を返す。goods フロアのフィルタリングに使う。"""
    rows = (await session.execute(select(Actress.name))).scalars().all()
    return {n for n in rows if n}


async def main(
    *,
    mode: str,
    hits_per_floor: int,
    floors_filter: list[str] | None,
    dry_run: bool,
    start_date: date | None,
    end_date: date | None,
    incremental_gte: str | None = None,
    incremental_lte: str | None = None,
) -> None:
    api_id = os.getenv("DMM_API_ID")
    # DMM API 呼び出し用 ID (末尾 -990〜-999 必須)
    api_affiliate_id = os.getenv("DMM_AFFILIATE_ID")
    if not api_id or not api_affiliate_id:
        raise SystemExit("DMM_API_ID / DMM_AFFILIATE_ID が設定されていません")
    # 購入ページ af_id 用 ID。未設定時は API 用 ID をフォールバックとして使う
    link_affiliate_id = os.getenv("DMM_LINK_AFFILIATE_ID") or api_affiliate_id
    print(
        f"[sync_catalog] api_affiliate_id={api_affiliate_id[:8]}*** "
        f"link_affiliate_id={link_affiliate_id[:8]}***"
    )

    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise SystemExit("DATABASE_URL が設定されていません")

    engine = create_async_engine(_get_async_url(db_url))
    Session = async_sessionmaker(engine, expire_on_commit=False)

    counters = UpsertCounters()
    # floors_filter 未指定 (cron 例) のときはデフォルトフロア (動画のみ) を使う
    if mode == "full":
        # フル同期は動画 2 フロア + goods をデフォルトにする (goods は DB 女優フィルタ付き)
        effective_filter = (
            {"videoa", "videoc", "goods"} if floors_filter is None else set(floors_filter)
        )
    else:
        effective_filter = (
            set(DEFAULT_FLOOR_NAMES) if floors_filter is None else set(floors_filter)
        )
    targets = [f for f in FLOORS if f[2] in effective_filter]

    print(
        f"[sync_catalog] start: mode={mode} hits_per_floor={hits_per_floor} "
        f"floors={[f[2] for f in targets]} dry_run={dry_run}"
    )

    async with httpx.AsyncClient() as client:
        async with Session() as session:
            # キャッシュをセッション開始時に 1 度だけ warm して N+1 SELECT を回避
            genre_cache = GenreCache()
            actress_cache = ActressCache()
            link_cache = MovieLinkCache()
            if not dry_run:
                await genre_cache.warm(session)
                await actress_cache.warm(session)
                print(
                    f"[sync_catalog] warmed caches: genres={len(genre_cache.by_name)} "
                    f"actresses={len(actress_cache.by_name)}"
                )

            # goods フロアで DB の女優と関連する作品だけ保存するため、女優キャッシュから直接取得
            db_actress_names: set[str] | None = None
            if any(f[2] == "goods" for f in targets):
                if not dry_run:
                    db_actress_names = actress_cache.names()
                else:
                    db_actress_names = await _load_db_actress_names(session)
                print(f"[sync_catalog] loaded {len(db_actress_names)} actress names for goods filter")

            for site, service, floor, prefix in targets:
                # goods は常に DB 女優フィルタをかける
                actress_filter = db_actress_names if floor == "goods" else None

                if mode == "full":
                    # 期間スライスして全件取得
                    if start_date is None or end_date is None:
                        raise SystemExit("full モードでは start_date / end_date が必要")
                    slices = _month_slices(start_date, end_date)
                    print(f"  [{floor}] full mode: {len(slices)} month slices ({start_date} .. {end_date})")
                    for gte, lte in slices:
                        await _run_floor_window(
                            client=client,
                            session=session,
                            api_id=api_id,
                            api_affiliate_id=api_affiliate_id,
                            link_affiliate_id=link_affiliate_id,
                            site=site,
                            service=service,
                            floor=floor,
                            prefix=prefix,
                            hits_limit=None,  # 全件取り切る
                            gte_date=gte,
                            lte_date=lte,
                            counters=counters,
                            dry_run=dry_run,
                            actress_filter=actress_filter,
                            genre_cache=genre_cache,
                            actress_cache=actress_cache,
                            link_cache=link_cache,
                        )
                else:
                    # incremental モード: 件数上限 + (任意) 期間フィルタ
                    # 年代サンプリング用に incremental_gte / incremental_lte を使うと
                    # 「この期間で入演作の先頭 N 件」を取ってこれる。
                    await _run_floor_window(
                        client=client,
                        session=session,
                        api_id=api_id,
                        api_affiliate_id=api_affiliate_id,
                        link_affiliate_id=link_affiliate_id,
                        site=site,
                        service=service,
                        floor=floor,
                        prefix=prefix,
                        hits_limit=hits_per_floor,
                        gte_date=incremental_gte,
                        lte_date=incremental_lte,
                        counters=counters,
                        dry_run=dry_run,
                        actress_filter=actress_filter,
                        genre_cache=genre_cache,
                        actress_cache=actress_cache,
                        link_cache=link_cache,
                    )
                # フロア切替時の sleep は不要 (AsyncLimiter がレート制御)

    await engine.dispose()
    print(
        f"[sync_catalog] done: inserted={counters.inserted} updated={counters.updated} "
        f"skipped={counters.skipped} errors={counters.errors}"
    )



if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        choices=["incremental", "full"],
        default="incremental",
        help=(
            "incremental: フロアごとに hits 件だけ取る (デフォルト、毎時 cron 用) / "
            "full: 期間スライスして全件取る (ブートストラップ / 月 1 用)"
        ),
    )
    parser.add_argument("--hits", type=int, default=100, help="incremental モードでの 1 フロアあたり取得件数 (デフォルト 100)")
    parser.add_argument(
        "--floors",
        type=str,
        default=None,
        help="対象フロアをカンマ区切りで限定 (例: videoa,videoc,goods)",
    )
    parser.add_argument(
        "--start-date",
        type=str,
        default="2000-01-01",
        help="full モードで取得する期間の開始日 (YYYY-MM-DD、デフォルト 2000-01-01)",
    )
    parser.add_argument(
        "--end-date",
        type=str,
        default="",
        help="full モードで取得する期間の終了日 (YYYY-MM-DD、空なら今日)",
    )
    parser.add_argument(
        "--gte-date",
        type=str,
        default="",
        help="incremental モードで期間フィルタをかけるときの下限 (YYYY-MM-DD)",
    )
    parser.add_argument(
        "--lte-date",
        type=str,
        default="",
        help="incremental モードで期間フィルタをかけるときの上限 (YYYY-MM-DD)",
    )
    parser.add_argument("--dry-run", action="store_true", help="DB に書き込まずにログだけ表示")
    args = parser.parse_args()

    floors_filter = None
    if args.floors:
        floors_filter = [f.strip() for f in args.floors.split(",") if f.strip()]

    start_date: date | None = None
    end_date: date | None = None
    if args.mode == "full":
        start_date = datetime.strptime(args.start_date, "%Y-%m-%d").date()
        end_date = (
            datetime.strptime(args.end_date, "%Y-%m-%d").date()
            if args.end_date
            else date.today()
        )

    # incremental モード用の期間フィルタ (DMM API の gte_date/lte_date は ISO 8601 なので
    # T00:00:00 / T23:59:59 を付ける)
    incremental_gte: str | None = None
    incremental_lte: str | None = None
    if args.gte_date:
        # 検証だけ (パースして退取りしたものは使わず、文字列に戻して使う)
        datetime.strptime(args.gte_date, "%Y-%m-%d")
        incremental_gte = f"{args.gte_date}T00:00:00"
    if args.lte_date:
        datetime.strptime(args.lte_date, "%Y-%m-%d")
        incremental_lte = f"{args.lte_date}T23:59:59"

    asyncio.run(main(
        mode=args.mode,
        hits_per_floor=args.hits,
        floors_filter=floors_filter,
        dry_run=args.dry_run,
        start_date=start_date,
        end_date=end_date,
        incremental_gte=incremental_gte,
        incremental_lte=incremental_lte,
    ))
