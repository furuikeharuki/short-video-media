import json
import random
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cache import get_redis
from app.repositories.movie_repository import (
    get_all_movies,
    get_all_movie_ids,
    get_movies_by_ids,
    get_movies_paginated,
)
from app.schemas.feed import FeedResponse
from app.schemas.movie import MovieCard, PriceList

SHUFFLE_CACHE_TTL = 3600  # 1時間
SHUFFLE_KEY_PREFIX = "feed:shuffle:"


def _to_card(movie) -> MovieCard:
    # price_list: JSONBからPriceListに変換（None安全）
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
        sample_movie_url=movie.sample_movie_url,
        affiliate_url=movie.affiliate_url,
        price_list=price_list,
        price_min=movie.price_min,
        review_count=movie.review_count or 0,
        review_average=float(movie.review_average) if movie.review_average else None,
        actresses=[a.name for a in movie.actresses],
        genres=[g.name for g in movie.genres],
        series_name=movie.series.name if movie.series else None,
    )


async def _get_shuffled_ids(
    db: AsyncSession,
    seed: int,
) -> list[str]:
    """
    seed に対応するシャッフル済み ID リストを Redis から取得。
    キャッシュときは DB から全 ID を取得しシャッフルして保存。
    """
    redis = get_redis()
    key = f"{SHUFFLE_KEY_PREFIX}{seed}"

    if redis is not None:
        cached = await redis.get(key)
        if cached:
            return json.loads(cached)

    ids = await get_all_movie_ids(db)
    rng = random.Random(seed)
    rng.shuffle(ids)

    if redis is not None:
        await redis.set(key, json.dumps(ids), ex=SHUFFLE_CACHE_TTL)

    return ids


async def get_feed(db: AsyncSession) -> FeedResponse:
    movies = await get_all_movies(db)
    items = [_to_card(m) for m in movies]
    return FeedResponse(items=items, next_cursor=None)


async def get_feed_paginated(
    db: AsyncSession,
    offset: int = 0,
    limit: int = 20,
    seed: int | None = None,
) -> FeedResponse:
    """
    seed あり: Redis キャッシュのシャッフル済み ID リストから offset/limit で切り出し。
    seed なし: フォールバックﾈﾈID 順）。
    """
    if seed is not None:
        shuffled_ids = await _get_shuffled_ids(db, seed)
        total = len(shuffled_ids)
        page_ids = shuffled_ids[offset: offset + limit]

        if not page_ids:
            return FeedResponse(items=[], next_cursor=None)

        id_map = await get_movies_by_ids(db, page_ids)
        items = [_to_card(id_map[i]) for i in page_ids if i in id_map]

        next_offset = offset + limit
        next_cursor = str(next_offset) if next_offset < total else None
        return FeedResponse(items=items, next_cursor=next_cursor)

    movies, total = await get_movies_paginated(db, offset=offset, limit=limit)
    items = [_to_card(m) for m in movies]
    next_offset = offset + limit
    next_cursor = str(next_offset) if next_offset < total else None
    return FeedResponse(items=items, next_cursor=next_cursor)
