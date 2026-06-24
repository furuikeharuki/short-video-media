import asyncio
import hashlib
import json
import logging
import random
from datetime import date
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cache import get_redis
from app.repositories.movie_repository import (
    get_all_movie_ids,
    get_movies_by_ids,
    get_movies_paginated,
)
from app.repositories.search_repository import get_advanced_movie_ids
from app.schemas.feed import FeedResponse
from app.schemas.movie import MovieCard, PriceList
from app.services import resolver_client


SortKey = Literal["new", "popular", "rating", "views", "bookmarks"]

SHUFFLE_CACHE_TTL = 3600
MOVIES_CACHE_TTL  = 1800
SHUFFLE_KEY_PREFIX = "feed:shuffle:"
MOVIES_KEY_PREFIX  = "movies:data:"
RESOLVER_WARM_AHEAD = 3
RESOLVER_INLINE_AHEAD = 3
RESOLVER_INLINE_TIMEOUT_S = 0.65
# 先頭ページ (offset=0 / 通常スクロール) だけは初回体感を最優先する。
# 同梱 URL 率を上げるため、待つ件数と待ち時間を広げる。Redis / in-flight dedupe /
# 成功キャッシュ + 事前 resolve job が効いていれば、ここはほぼ即時に返る
# (DMM 実アクセスが必要な cold miss のときだけ最大 timeout まで待つ)。
#
# AHEAD は既定 page size (limit=20) と揃え、先頭ページを「完全 resolved feed」化
# する (ユーザー要望「先頭 10〜20 件を完全 resolved に」)。間に合わなかった分は
# cancel せず背景で継続し、resolver の成功キャッシュ / in-flight dedupe を温める
# ため、フロントが直後に叩く /resolve-mp4 が即ヒットする。worst-case のレスポンス
# 遅延は AHEAD ではなく TIMEOUT_S で頭打ちになる (件数を増やしても待ち時間は不変)。
RESOLVER_INLINE_FIRST_PAGE_AHEAD = 20
RESOLVER_INLINE_FIRST_PAGE_TIMEOUT_S = 1.2

logger = logging.getLogger(__name__)
_resolver_warm_tasks: set[asyncio.Task[None]] = set()
_resolver_inline_tasks: set[asyncio.Task[tuple[MovieCard, resolver_client.ResolvedMp4 | None]]] = set()


def _to_card(movie) -> MovieCard:
    price_list = None
    if movie.price_list:
        price_list = PriceList.model_validate(movie.price_list)

    return MovieCard(
        id=str(movie.id),
        content_id=movie.content_id,
        title=movie.title,
        slug=movie.slug,
        image_url_list=movie.image_url_list,
        image_url_large=movie.image_url_large,
        affiliate_url=movie.affiliate_url,
        price_list=price_list,
        price_min=movie.price_min,
        review_count=movie.review_count or 0,
        review_average=float(movie.review_average) if movie.review_average else None,
        actresses=[a.name for a in movie.actresses],
        genres=[g.name for g in movie.genres],
        series_name=movie.series.name if movie.series else None,
    )


def _card_to_dict(card: MovieCard) -> dict:
    return card.model_dump()


def _attach_resolved_mp4(card: MovieCard, resolved: resolver_client.ResolvedMp4) -> None:
    card.mp4_url = resolved.mp4_url
    card.low_mp4_url = resolved.low_mp4_url or resolved.mp4_url
    card.high_mp4_url = resolved.high_mp4_url or resolved.mp4_url


async def _resolve_feed_card(
    card: MovieCard,
) -> tuple[MovieCard, resolver_client.ResolvedMp4 | None]:
    if not card.content_id:
        return card, None
    try:
        return card, await resolver_client.resolve_mp4(card.content_id)
    except resolver_client.ResolverConfigError:
        return card, None
    except Exception:  # noqa: BLE001
        logger.debug(
            "feed inline resolver failed: content_id=%s",
            card.content_id,
            exc_info=True,
        )
        return card, None


def _consume_inline_task(
    task: asyncio.Task[tuple[MovieCard, resolver_client.ResolvedMp4 | None]],
) -> None:
    _resolver_inline_tasks.discard(task)
    try:
        task.result()
    except Exception:  # noqa: BLE001
        logger.debug("feed inline resolver background task failed", exc_info=True)


async def _attach_inline_resolved_urls(
    items: list[MovieCard],
    *,
    ahead: int = RESOLVER_INLINE_AHEAD,
    timeout_s: float = RESOLVER_INLINE_TIMEOUT_S,
) -> None:
    """先頭数件だけ短時間待って MP4 URL を feed レスポンスに同梱する。

    `timeout_s` 以内に解決できたものだけ `MovieCard` に反映する。間に合わない
    task は cancel せずに継続し、resolver の in-flight dedupe / 成功キャッシュを
    温める (次ページ / 次リクエストが即ヒットする)。
    """
    targets: list[MovieCard] = []
    seen: set[str] = set()
    for item in items:
        if not item.content_id or item.content_id in seen:
            continue
        seen.add(item.content_id)
        targets.append(item)
        if len(targets) >= ahead:
            break
    if not targets:
        return

    try:
        tasks = [asyncio.create_task(_resolve_feed_card(item)) for item in targets]
    except RuntimeError:
        return

    done, pending = await asyncio.wait(tasks, timeout=timeout_s)
    for task in done:
        card, resolved = task.result()
        if resolved is not None:
            _attach_resolved_mp4(card, resolved)

    for task in pending:
        _resolver_inline_tasks.add(task)
        task.add_done_callback(_consume_inline_task)


def _inline_resolve_params(offset: int) -> tuple[int, float]:
    """offset に応じた inline resolve の (件数, タイムアウト秒)。

    先頭ページ (offset=0) は初回体感を優先して広めに待つ。2 ページ目以降は
    既に再生に入っており warm / prefetch も効くので、軽め (既定値) に留める。
    """
    if offset <= 0:
        return RESOLVER_INLINE_FIRST_PAGE_AHEAD, RESOLVER_INLINE_FIRST_PAGE_TIMEOUT_S
    return RESOLVER_INLINE_AHEAD, RESOLVER_INLINE_TIMEOUT_S


def _schedule_resolver_warm(items: list[MovieCard]) -> None:
    """Feed 先頭数件の MP4 resolver 成功キャッシュを非同期で温める。

    レスポンスは待たせない。フロントが直後に /resolve-mp4 を叩いたとき、
    in-flight dedupe または成功キャッシュに乗ることを狙う。
    """
    content_ids: list[str] = []
    seen: set[str] = set()
    for item in items:
        if not item.content_id or item.content_id in seen:
            continue
        seen.add(item.content_id)
        content_ids.append(item.content_id)
        if len(content_ids) >= RESOLVER_WARM_AHEAD:
            break
    if not content_ids:
        return

    async def warm_one(content_id: str) -> None:
        try:
            await resolver_client.resolve_mp4(content_id)
        except resolver_client.ResolverConfigError:
            # ローカル開発など DMM_AFFILIATE_ID 未設定環境では黙って無効化。
            return
        except Exception:  # noqa: BLE001
            logger.debug("feed resolver warm failed: content_id=%s", content_id, exc_info=True)

    async def warm_batch() -> None:
        await asyncio.gather(*(warm_one(content_id) for content_id in content_ids))

    try:
        task = asyncio.create_task(warm_batch())
        _resolver_warm_tasks.add(task)
        task.add_done_callback(_resolver_warm_tasks.discard)
    except RuntimeError:
        # テスト等で running loop が無い経路では何もしない。
        return


def _adv_cache_key(seed: int, adv: dict) -> str:
    """advanced 条件入りシャッフル ID 一覧のキャッシュキー。

    キャッシュバスト用に条件 dict を sha1 でハッシュ化したものをキーに混ぜる。
    """
    payload = json.dumps(adv, sort_keys=True, default=str, ensure_ascii=False)
    h = hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]
    return f"{SHUFFLE_KEY_PREFIX}{seed}:adv:{h}"


async def _get_shuffled_ids(
    db: AsyncSession,
    seed: int,
    genres: list[str] | None = None,
) -> list[str]:
    redis = get_redis()
    genre_key = ",".join(sorted(genres)) if genres else "all"
    key = f"{SHUFFLE_KEY_PREFIX}{seed}:{genre_key}"

    if redis is not None:
        cached = await redis.get(key)
        if cached:
            return json.loads(cached)

    ids = await get_all_movie_ids(db, genres=genres)
    rng = random.Random(seed)
    rng.shuffle(ids)

    if redis is not None:
        await redis.set(key, json.dumps(ids), ex=SHUFFLE_CACHE_TTL)

    return ids


async def _get_advanced_shuffled_ids(
    db: AsyncSession,
    seed: int,
    *,
    q: str | None,
    genres: list[str],
    actresses: list[str],
    series_list: list[str],
    directors: list[str],
    makers: list[str],
    labels: list[str],
    ng_words: list[str],
    date_from: date | None,
    date_to: date | None,
    sort: SortKey | None = None,
) -> list[str]:
    """詳細検索条件にマッチする movie_id を返す (redis キャッシュ)。

    sort 未指定: 从来通り seed で shuffle して返す。
    sort 指定あり: shuffle せず、指定されたソート順 (検索結果と同じ ORDER BY)で返す。
    """
    adv_dict = {
        "q": q or "",
        "genres": sorted(genres),
        "actresses": sorted(actresses),
        "series_list": sorted(series_list),
        "directors": sorted(directors),
        "makers": sorted(makers),
        "labels": sorted(labels),
        "ng_words": sorted(ng_words),
        "date_from": date_from.isoformat() if date_from else "",
        "date_to": date_to.isoformat() if date_to else "",
        "sort": sort or "",
    }
    redis = get_redis()
    key = _adv_cache_key(seed, adv_dict)

    if redis is not None:
        cached = await redis.get(key)
        if cached:
            return json.loads(cached)

    ids = await get_advanced_movie_ids(
        db,
        q=q or None,
        genres=genres or None,
        actresses=actresses or None,
        series_list=series_list or None,
        directors=directors or None,
        makers=makers or None,
        labels=labels or None,
        ng_words=ng_words or None,
        date_from=date_from,
        date_to=date_to,
        sort=sort,
    )
    # sort 指定があるときは DB 側の ORDER BY をそのまま使う (= shuffle しない)。
    # 未指定のときだけ 従来通り seed で shuffle したランダム順フィードにする。
    if sort is None:
        rng = random.Random(seed)
        rng.shuffle(ids)

    if redis is not None:
        await redis.set(key, json.dumps(ids), ex=SHUFFLE_CACHE_TTL)

    return ids


async def _get_movies_with_cache(
    db: AsyncSession,
    page_ids: list[str],
) -> dict[str, MovieCard]:
    redis = get_redis()
    result: dict[str, MovieCard] = {}
    missing_ids: list[str] = []

    if redis is not None:
        for movie_id in page_ids:
            key = f"{MOVIES_KEY_PREFIX}{movie_id}"
            cached = await redis.get(key)
            if cached:
                data = json.loads(cached)
                result[movie_id] = MovieCard.model_validate(data)
            else:
                missing_ids.append(movie_id)
    else:
        missing_ids = page_ids

    if missing_ids:
        id_map = await get_movies_by_ids(db, missing_ids)
        for movie_id, movie in id_map.items():
            card = _to_card(movie)
            result[movie_id] = card
            if redis is not None:
                key = f"{MOVIES_KEY_PREFIX}{movie_id}"
                await redis.set(key, json.dumps(_card_to_dict(card)), ex=MOVIES_CACHE_TTL)

    return result


def _has_advanced_filter(
    *,
    q: str | None,
    actresses: list[str],
    series_list: list[str],
    directors: list[str],
    makers: list[str],
    labels: list[str],
    ng_words: list[str],
    date_from: date | None,
    date_to: date | None,
) -> bool:
    """advanced 経路に乗せるべきかどうか (genres 以外で条件が指定されているか)。

    genres は元々フィードでサポートしていたフィルターなので、これだけの場合は
    既存の `_get_shuffled_ids(seed, genres=...)` 経路をそのまま使うほうが速い
    (M:N ジャンル AND ではなく OR でいい既存挙動を維持する)。
    """
    return bool(
        (q and q.strip())
        or actresses
        or series_list
        or directors
        or makers
        or labels
        or ng_words
        or date_from is not None
        or date_to is not None
    )


async def get_feed_paginated(
    db: AsyncSession,
    offset: int = 0,
    limit: int = 20,
    seed: int | None = None,
    genres: list[str] | None = None,
    *,
    q: str | None = None,
    actresses: list[str] | None = None,
    series_list: list[str] | None = None,
    directors: list[str] | None = None,
    makers: list[str] | None = None,
    labels: list[str] | None = None,
    ng_words: list[str] | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    sort: SortKey | None = None,
) -> FeedResponse:
    genres_norm = genres or []
    actresses_norm = actresses or []
    series_list_norm = series_list or []
    directors_norm = directors or []
    makers_norm = makers or []
    labels_norm = labels or []
    ng_words_norm = ng_words or []

    advanced = _has_advanced_filter(
        q=q,
        actresses=actresses_norm,
        series_list=series_list_norm,
        directors=directors_norm,
        makers=makers_norm,
        labels=labels_norm,
        ng_words=ng_words_norm,
        date_from=date_from,
        date_to=date_to,
    )
    # sort が指定されたときも advanced 経路に乗せる (ORDER BY を DB 側で適用したいため)。
    # genres ジャンルだけ指定 + sort 指定のケースも advanced 経路に完全一致 AND で乗せればいい。
    if sort is not None:
        advanced = True

    inline_ahead, inline_timeout_s = _inline_resolve_params(offset)

    # advanced 経路: 必ず seed (= shuffle) が必要。seed 無しなら 0 で固定し、安定した順序にする。
    if advanced:
        effective_seed = seed if seed is not None else 0
        shuffled_ids = await _get_advanced_shuffled_ids(
            db,
            effective_seed,
            q=q,
            # advanced 経路は genres も AND 条件 (`advanced_search_movies`) に乗せる
            genres=genres_norm,
            actresses=actresses_norm,
            series_list=series_list_norm,
            directors=directors_norm,
            makers=makers_norm,
            labels=labels_norm,
            ng_words=ng_words_norm,
            date_from=date_from,
            date_to=date_to,
            sort=sort,
        )
        total = len(shuffled_ids)
        page_ids = shuffled_ids[offset: offset + limit]
        if not page_ids:
            return FeedResponse(items=[], next_cursor=None, total=total)

        card_map = await _get_movies_with_cache(db, page_ids)
        items = [card_map[i] for i in page_ids if i in card_map]
        await _attach_inline_resolved_urls(
            items, ahead=inline_ahead, timeout_s=inline_timeout_s
        )
        _schedule_resolver_warm(items)
        next_offset = offset + limit
        next_cursor = str(next_offset) if next_offset < total else None
        return FeedResponse(items=items, next_cursor=next_cursor, total=total)

    # 既存ルート (genres 単独 OR / または無条件) はそのまま
    if seed is not None:
        shuffled_ids = await _get_shuffled_ids(db, seed, genres=genres_norm or None)
        total = len(shuffled_ids)
        page_ids = shuffled_ids[offset: offset + limit]

        if not page_ids:
            return FeedResponse(items=[], next_cursor=None, total=total)

        card_map = await _get_movies_with_cache(db, page_ids)
        items = [card_map[i] for i in page_ids if i in card_map]
        await _attach_inline_resolved_urls(
            items, ahead=inline_ahead, timeout_s=inline_timeout_s
        )
        _schedule_resolver_warm(items)

        next_offset = offset + limit
        next_cursor = str(next_offset) if next_offset < total else None
        return FeedResponse(items=items, next_cursor=next_cursor, total=total)

    movies, total = await get_movies_paginated(
        db, offset=offset, limit=limit, genres=genres_norm or None
    )
    items = [_to_card(m) for m in movies]
    await _attach_inline_resolved_urls(
        items, ahead=inline_ahead, timeout_s=inline_timeout_s
    )
    _schedule_resolver_warm(items)
    next_offset = offset + limit
    next_cursor = str(next_offset) if next_offset < total else None
    return FeedResponse(items=items, next_cursor=next_cursor, total=total)
