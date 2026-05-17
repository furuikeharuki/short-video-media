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
  - DMM_API_ID
  - DMM_AFFILIATE_ID
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
from datetime import date, datetime
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
from app.db.models.movie import Movie, MovieActress, MovieGenre  # noqa: E402
from app.db.models.series import Series  # noqa: E402


DMM_ENDPOINT = "https://api.dmm.com/affiliate/v3/ItemList"
RATE_LIMIT_SLEEP_SEC = 1.0

# (site, service, floor, key_prefix)
# key_prefix は content_id のフォールバック識別子用
FLOORS: list[tuple[str, str, str, str]] = [
    ("FANZA", "digital", "videoa", "videoa"),  # 単体女優物 / ビデオ
    ("FANZA", "digital", "videoc", "videoc"),  # アマチュア
    ("FANZA", "mono",    "goods",  "goods"),   # 女優グッズ
]


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


async def fetch_items(client: httpx.AsyncClient, fp: FetchParams) -> list[dict]:
    params = {
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
    items = result.get("items") or []
    return items


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
    dry_run: bool = False,
) -> None:
    content_id = _build_content_id(item, floor_prefix)
    iteminfo = item.get("iteminfo") or {}

    # 既存チェック
    existing = (
        await session.execute(select(Movie).where(Movie.content_id == content_id))
    ).scalar_one_or_none()

    title = item.get("title") or item.get("name") or "(無題)"
    slug = existing.slug if existing else _build_slug(item, content_id)

    image_urls = item.get("imageURL") or {}
    sample_movie = (item.get("sampleMovieURL") or {})
    sample_image = (item.get("sampleImageURL") or {})

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
        movie.image_url_list = image_urls.get("list") or movie.image_url_list
        movie.image_url_large = image_urls.get("large") or movie.image_url_large
        movie.sample_movie_url = (sample_movie.get("size_720_480") or sample_movie.get("size_644_414") or sample_movie.get("size_560_360") or movie.sample_movie_url)
        # sample_embed_url は DMM ItemList には基本含まれないので既存値を維持
        movie.affiliate_url = item.get("affiliateURL") or movie.affiliate_url
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
            image_url_list=image_urls.get("list"),
            image_url_large=image_urls.get("large"),
            sample_movie_url=(sample_movie.get("size_720_480") or sample_movie.get("size_644_414") or sample_movie.get("size_560_360")),
            sample_embed_url=None,
            affiliate_url=item.get("affiliateURL") or "",
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
    genres_arr = iteminfo.get("genre") or []
    if isinstance(genres_arr, list) and genres_arr and not dry_run:
        await _sync_genres(session, movie.id, [g.get("name") for g in genres_arr if g.get("name")])

    # 女優
    actresses_arr = iteminfo.get("actress") or []
    if isinstance(actresses_arr, list) and actresses_arr and not dry_run:
        await _sync_actresses(session, movie.id, actresses_arr)


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
# メイン
# ────────────────────────────────────────────────────────────

async def main(*, hits_per_floor: int, floors_filter: list[str] | None, dry_run: bool) -> None:
    api_id = os.getenv("DMM_API_ID")
    affiliate_id = os.getenv("DMM_AFFILIATE_ID")
    if not api_id or not affiliate_id:
        raise SystemExit("DMM_API_ID / DMM_AFFILIATE_ID が設定されていません")

    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise SystemExit("DATABASE_URL が設定されていません")

    engine = create_async_engine(_get_async_url(db_url))
    Session = async_sessionmaker(engine, expire_on_commit=False)

    counters = UpsertCounters()
    targets = [f for f in FLOORS if (floors_filter is None or f[2] in floors_filter)]

    print(f"[sync_catalog] start: hits_per_floor={hits_per_floor}, floors={[f[2] for f in targets]}, dry_run={dry_run}")

    async with httpx.AsyncClient() as client:
        async with Session() as session:
            for site, service, floor, prefix in targets:
                # 1 リクエスト最大 100 件。hits_per_floor がそれ以上ならページングする
                fetched = 0
                offset = 1
                while fetched < hits_per_floor:
                    batch_size = min(100, hits_per_floor - fetched)
                    fp = FetchParams(
                        api_id=api_id,
                        affiliate_id=affiliate_id,
                        site=site,
                        service=service,
                        floor=floor,
                        hits=batch_size,
                        offset=offset,
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

                    print(f"  [{floor}] offset={offset} got {len(items)} items")
                    for item in items:
                        try:
                            await upsert_movie(session, item, prefix, counters, dry_run=dry_run)
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

                    fetched += len(items)
                    offset += len(items)
                    if len(items) < batch_size:
                        break
                    time.sleep(RATE_LIMIT_SLEEP_SEC)
                # フロア切替時もちょっと休む
                time.sleep(RATE_LIMIT_SLEEP_SEC)

    await engine.dispose()
    print(
        f"[sync_catalog] done: inserted={counters.inserted} updated={counters.updated} "
        f"skipped={counters.skipped} errors={counters.errors}"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--hits", type=int, default=100, help="1 フロアあたりの取得件数 (デフォルト 100)")
    parser.add_argument(
        "--floors",
        type=str,
        default=None,
        help="対象フロアをカンマ区切りで限定 (例: videoa,videoc,goods)",
    )
    parser.add_argument("--dry-run", action="store_true", help="DB に書き込まずログだけ表示")
    args = parser.parse_args()

    floors_filter = None
    if args.floors:
        floors_filter = [f.strip() for f in args.floors.split(",") if f.strip()]

    asyncio.run(main(
        hits_per_floor=args.hits,
        floors_filter=floors_filter,
        dry_run=args.dry_run,
    ))
