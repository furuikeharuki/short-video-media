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
  - DMM_LINK_AFFILIATE_ID   : 購入ページ紐付け用 ID (例: xxxxxx-001)
                              未設定時は DMM_AFFILIATE_ID をフォールバック
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
import time
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
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
RATE_LIMIT_SLEEP_SEC = 1.0

# (site, service, floor, key_prefix)
# key_prefix は content_id のフォールバック識別子用
FLOORS: list[tuple[str, str, str, str]] = [
    ("FANZA", "digital", "videoa", "videoa"),  # 単体女優物 / ビデオ
    ("FANZA", "digital", "videoc", "videoc"),  # アマチュア
    ("FANZA", "mono",    "goods",  "goods"),   # 女優グッズ (現状 cron では取得しない)
]

# cron など floors 未指定時に取得するデフォルトフロア (動画のみ)
DEFAULT_FLOOR_NAMES: tuple[str, ...] = ("videoa", "videoc")

# floor → 購入ページ URL テンプレート
# DMM API が返す al.fanza.co.jp 形式のアフィリエイトリンクは新規アカウントで
# 「無効リンク」になるため、af_id を直接付けた本家 URL を組み立てる
_AFFILIATE_URL_TEMPLATES: dict[str, str] = {
    "videoa": "https://www.dmm.co.jp/digital/videoa/-/detail/=/cid={cid}/?af_id={af_id}&ch=link_tool",
    "videoc": "https://www.dmm.co.jp/digital/videoc/-/detail/=/cid={cid}/?af_id={af_id}&ch=link_tool",
    "goods":  "https://www.dmm.co.jp/mono/goods/-/detail/=/cid={cid}/?af_id={af_id}&ch=link_tool",
}


def _build_affiliate_url(content_id: str, floor: str, affiliate_id: str) -> str:
    """floor に応じた DMM 購入ページ URL を組み立てる。
    DMM API が返す `affiliateURL` (al.fanza.co.jp 経由) は新規アカウントで
    拒否される ("無効リンク") ため、直接 cid を含むページ URL に af_id を付与する。
    """
    tpl = _AFFILIATE_URL_TEMPLATES.get(floor)
    if tpl is None:
        # 未知の floor は videoa パターンにフォールバック
        tpl = _AFFILIATE_URL_TEMPLATES["videoa"]
    return tpl.format(cid=content_id, af_id=affiliate_id)


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
    """DMM ItemList API を叩いて result コンテナをそのまま返す。"""
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


def _strip_zero_padding(cid: str) -> str:
    """DMM content_id の中央数字部の先頭ゼロを削る。

    例: mmmb00181 -> mmmb181 / scop00912 -> scop912 / 1sun00054a -> 1sun54a / host00001 -> host1
    パターン: 先頭数字(任意) + 英字ブロック + 数字 + 末尾英字(任意)
    マッチしないときはそのまま返す。
    """
    import re as _re
    m = _re.match(r"^(\d*)([a-zA-Z_]+)(\d+)([a-zA-Z]?)$", cid)
    if not m:
        return cid
    prefix_num, alpha, num, tail = m.groups()
    return f"{prefix_num}{alpha}{int(num)}{tail}"


def _build_sample_mp4_url(content_id: str) -> str | None:
    """DMM の content_id から MP4 直リンク URL を組み立てる。

    DMM API が返す `sampleMovieURL.size_*` は実際には HTML プレイヤーページ
    (iframe 埋め込み用) であり、`<video src>` には使えない。
    実際の MP4 ファイルは下記パターンで配信されている:
        //cc3001.dmm.co.jp/litevideo/freepv/{c[0]}/{c[:3]}/{cid}/{cid}_mhb_w.mp4

    重要: 多くの作品で CDN のパスに使われる cid は DMM API の content_id
    と同じではなく、中央数字部の先頭ゼロパディングが剣げた表記になっている。
    例: API の content_id `mmmb00181` -> CDN パスは `mmmb181`
          API の content_id `scop00912` -> CDN パスは `scop912`
    そのため、サーバー側では パディング無しをデフォルトとし、クライアント側で
    onError 時にパディング有り・別 suffix を順番に試す。
    """
    cid = (content_id or "").strip().lower()
    if not cid:
        return None
    # ゼロパディングを削った表記を使う
    cid_no_pad = _strip_zero_padding(cid)
    # CDN パスの prefix に使う cid は先頭の数字を除いたもの。
    cid_for_url = cid_no_pad.lstrip("0123456789")
    if not cid_for_url or not cid_for_url[0].isalpha():
        return None
    prefix1 = cid_for_url[0]
    prefix3 = cid_for_url[:3]
    return (
        f"https://cc3001.dmm.co.jp/litevideo/freepv/"
        f"{prefix1}/{prefix3}/{cid_no_pad}/{cid_no_pad}_mhb_w.mp4"
    )


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


@dataclass
class UpsertCounters:
    inserted: int = 0
    updated: int = 0
    skipped: int = 0
    errors: int = 0


async def upsert_movie(
    session: AsyncSession,
    item: dict,
    floor_prefix: str,
    counters: UpsertCounters,
    *,
    affiliate_id: str,
    floor: str,
    dry_run: bool = False,
    refresh_sample_url: bool = False,
    actress_filter: set[str] | None = None,
) -> None:
    """DMM API の 1 件を Movie テーブルに upsert する。

    :param refresh_sample_url:
        True なら既存作品の sample_movie_url を DMM ロジックで再生成した URL で上書きする。
        False (デフォルト) のときは既存値を保護 (クライアント学習キャッシュを壊さない)。
    :param actress_filter:
        与えられたとき、作品に含まれる女優名がこのセットに 1 つも一致しなければ skip。
        goods フロアで DB に存在する女優に関連する商品だけ保存するために使う。
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

    # DMM API が返す sampleMovieURL.size_720_480 は HTML プレイヤーページ
    # (www.dmm.co.jp/litevideo/-/part/=/...) であり、<video src> に直接
    # 渡しても動画として読み込めない。実際の MP4 ファイルは content_id から
    # 自前で組み立てる必要がある。
    sample_movie_url = _build_sample_mp4_url(content_id)

    # iframe プレイヤー URL は別カラムに保持 (フォールバック / 埋め込み用途)
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

    # アフィリエイト URL を自前で組み立てる (DMM API が返す al.fanza.co.jp は無効リンクになる)
    affiliate_url = _build_affiliate_url(content_id, floor, affiliate_id)

    price_list, price_min = _extract_price_list(item)
    review_count, review_avg = _extract_review(item)

    # 制作者情報 (リストになる場合があるので最初の 1 件)
    def _first_name(key: str) -> str | None:
        arr = iteminfo.get(key) or []
        if isinstance(arr, list) and arr:
            return arr[0].get("name")
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
        # sample_movie_url: クライアントがフォールバックで見つけた有効 URL を
        # キャッシュしているため、送信でオリジナルロジックに戻さないよう保護する。
        #   - 毎時 cron (refresh_sample_url=False): 既存値が空のときだけセット
        #   - フル同期 (refresh_sample_url=True): 常に上書き（月 1 のリセットタイミング）
        if refresh_sample_url:
            movie.sample_movie_url = sample_movie_url or movie.sample_movie_url
        elif not movie.sample_movie_url:
            movie.sample_movie_url = sample_movie_url
        movie.sample_embed_url = sample_embed_url or movie.sample_embed_url
        # affiliate_url は常に自前生成のもので上書き (既存データの無効リンクを一括で修復する)
        movie.affiliate_url = affiliate_url
        movie.affiliate_url_en = item.get("affiliateURLs_mobile") or movie.affiliate_url_en
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
            sample_movie_url=sample_movie_url,
            sample_embed_url=sample_embed_url,
            affiliate_url=affiliate_url,
            affiliate_url_en=item.get("affiliateURLs_mobile"),
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
        await _sync_genres(session, movie.id, genre_names)

    # 女優
    actresses_arr = iteminfo.get("actress") or []
    if isinstance(actresses_arr, list) and actresses_arr and not dry_run:
        await _sync_actresses(session, movie.id, actresses_arr)


def _floor_genre_label(floor: str) -> str | None:
    """フロア名から UI 表示用の擬似ジャンル名を返す。

    「アマチュア」としているのは、DMM が本来付けるジャンル「素人」と被らせないため。
    """
    if floor == "videoa":
        return "プロ女優"
    if floor == "videoc":
        return "アマチュア"
    return None


async def _sync_genres(session: AsyncSession, movie_id: str, names: list[str]) -> None:
    if not names:
        return
    # 既存ジャンル取得
    existing_genres = (
        await session.execute(select(Genre).where(Genre.name.in_(names)))
    ).scalars().all()
    name_to_genre = {g.name: g for g in existing_genres}

    # 未登録ジャンルを追加
    for name in names:
        if name not in name_to_genre:
            g = Genre(name=name)
            session.add(g)
            await session.flush()
            name_to_genre[name] = g

    # 既存リンクを取得して未登録のものだけ追加
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
) -> None:
    """DMM goods フロアの 1 件を Goods テーブルに upsert する。

    Movie とは独立したテーブルに保存し、女優詳細ページの「関連商品」セクションでだけ
    参照する。sample_movie_url / sample_embed_url / director / series はない。

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
    affiliate_url = _build_affiliate_url(content_id, "goods", affiliate_id)
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

    # goods の画像 URL は DMM API が返す imageURL をベースにする。
    # API は通常 pt.jpg (一覧用サムネ) と ps.jpg (小) しか返さず、pl.jpg (大) は欠ける
    # ことが多いが、実際には CDN 上に pl.jpg は存在する。そのため API の pt/ps URL から
    # 同じパスの pl.jpg を生成して大画像として採用する。
    api_list = image_urls.get("list") or image_urls.get("small")
    new_image_list = api_list
    new_image_large = (
        image_urls.get("large")
        or _upgrade_goods_image_to_pl(api_list)
        or api_list
    )
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
        await _link_goods_actresses(session, goods.id, matched_names)


async def _link_goods_actresses(
    session: AsyncSession, goods_id: str, actress_names: list[str]
) -> None:
    """商品と (既存) 女優の多対多リンクを設定する。未登録女優はここでは作らない。"""
    if not actress_names:
        return
    actresses = (
        await session.execute(
            select(Actress).where(Actress.name.in_(actress_names))
        )
    ).scalars().all()
    if not actresses:
        return

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


async def _sync_actresses(session: AsyncSession, movie_id: str, actress_items: list[dict]) -> None:
    if not actress_items:
        return
    # DMM 側 id (content_id) を優先キーに、無ければ name で探す
    for pos, a in enumerate(actress_items):
        a_cid = str(a.get("id")) if a.get("id") is not None else None
        a_name = a.get("name")
        if not a_name:
            continue

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
            # 補完
            if a_cid and not actress.content_id:
                actress.content_id = a_cid
            if a.get("ruby") and not actress.ruby:
                actress.ruby = a.get("ruby")

        # 関連
        link = (
            await session.execute(
                select(MovieActress).where(
                    MovieActress.movie_id == movie_id,
                    MovieActress.actress_id == actress.id,
                )
            )
        ).scalar_one_or_none()
        if link is None:
            session.add(MovieActress(movie_id=movie_id, actress_id=actress.id, position=pos))


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
    refresh_sample_url: bool,
    actress_filter: set[str] | None,
) -> None:
    """取得した items リストを 1 件ずつ upsert してコミットする。"""
    for item in items:
        try:
            await upsert_movie(
                session,
                item,
                prefix,
                counters,
                affiliate_id=affiliate_id,
                floor=floor,
                dry_run=dry_run,
                refresh_sample_url=refresh_sample_url,
                actress_filter=actress_filter,
            )
            # 1件ずつコミット: そうしないと 1 件失敗で batch 全体が巻き込まれる
            if not dry_run:
                await session.commit()
        except Exception as e:  # noqa: BLE001
            print(f"    [ERROR] upsert failed cid={item.get('content_id')}: {e}")
            counters.errors += 1
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
    refresh_sample_url: bool,
    actress_filter: set[str] | None,
) -> None:
    """一つの (floor, 期間ウィンドウ) を offset でページングして全件取得し、upsert する。

    :param hits_limit:
        上限件数。未指定 (None) のときは API が返すだけ取り切る (全件モード)。
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
            refresh_sample_url=refresh_sample_url,
            actress_filter=actress_filter,
        )
        fetched += len(items)
        offset += len(items)
        if len(items) < batch_size:
            break
        time.sleep(RATE_LIMIT_SLEEP_SEC)


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
    refresh_sample_url: bool,
    start_date: date | None,
    end_date: date | None,
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
        f"floors={[f[2] for f in targets]} dry_run={dry_run} "
        f"refresh_sample_url={refresh_sample_url}"
    )

    async with httpx.AsyncClient() as client:
        async with Session() as session:
            # goods フロアで DB の女優と関連する作品だけ保存するため、先に名前リストをロード
            db_actress_names: set[str] | None = None
            if any(f[2] == "goods" for f in targets):
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
                            refresh_sample_url=refresh_sample_url,
                            actress_filter=actress_filter,
                        )
                else:
                    # incremental モード: 期間指定なし、件数上限だけ
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
                        gte_date=None,
                        lte_date=None,
                        counters=counters,
                        dry_run=dry_run,
                        refresh_sample_url=refresh_sample_url,
                        actress_filter=actress_filter,
                    )
                # フロア切替時もちょっと休む
                time.sleep(RATE_LIMIT_SLEEP_SEC)

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
        "--refresh-sample-url",
        action="store_true",
        help="sample_movie_url を常に上書き (未指定時は既存値を保護 = クライアント学習キャッシュを壊さない)",
    )
    parser.add_argument("--dry-run", action="store_true", help="DB に書き込まずにログだけ表示")
    args = parser.parse_args()

    floors_filter = None
    if args.floors:
        floors_filter = [f.strip() for f in args.floors.split(",") if f.strip()]

    # full モードはデフォルトで refresh_sample_url=True (月 1 のリセットタイミング)
    refresh_sample_url = args.refresh_sample_url or (args.mode == "full")

    start_date: date | None = None
    end_date: date | None = None
    if args.mode == "full":
        start_date = datetime.strptime(args.start_date, "%Y-%m-%d").date()
        end_date = (
            datetime.strptime(args.end_date, "%Y-%m-%d").date()
            if args.end_date
            else date.today()
        )

    asyncio.run(main(
        mode=args.mode,
        hits_per_floor=args.hits,
        floors_filter=floors_filter,
        dry_run=args.dry_run,
        refresh_sample_url=refresh_sample_url,
        start_date=start_date,
        end_date=end_date,
    ))
