import json
import random
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cache import get_redis
from app.repositories.movie_repository import (
    get_all_movie_ids,
    get_movies_by_ids,
    get_movies_paginated,
)
from app.schemas.feed import FeedResponse
from app.schemas.movie import MovieCard, PriceList

SHUFFLE_CACHE_TTL = 3600   # 1時間
MOVIES_CACHE_TTL  = 1800   # 30分
SHUFFLE_KEY_PREFIX = "feed:shuffle:"
MOVIES_KEY_PREFIX  = "movies:data:"


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


def _card_to_dict(card: MovieCard) -> dict:
    return card.model_dump()


async def _get_shuffled_ids(
    db: AsyncSession,
    seed: int,
) -> list[str]:
    """
    seed に対応するシャッフル済み ID リストを Redis から取得。
    キャッシュなし時は DB から全 ID を取得しシャッフルして保存。
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


async def _get_movies_with_cache(
    db: AsyncSession,
    page_ids: list[str],
) -> dict[str, MovieCard]:
    """
    動画データをRedisキャッシュから取得。
    キャッシュミスしたIDのみDBから取得してキャッシュに保存する。
    """
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


async def get_feed_paginated(
    db: AsyncSession,
    offset: int = 0,
    limit: int = 20,
    seed: int | None = None,
) -> FeedResponse:
    """
    seed あり: Redis キャッシュのシャッフル済み ID リストから offset/limit で切り出し。
    seed なし: フォールバック（ID 順）。

    NOTE: get_all_movies（全件取得）は意図的に削除済み。
          大量データでのメモリ枯渇を防ぐため、必ずページネーションを使うこと。
    """
    if seed is not None:
        shuffled_ids = await _get_shuffled_ids(db, seed)
        total = len(shuffled_ids)
        page_ids = shuffled_ids[offset: offset + limit]

        if not page_ids:
            return FeedResponse(items=[], next_cursor=None)

        card_map = await _get_movies_with_cache(db, page_ids)
        items = [card_map[i] for i in page_ids if i in card_map]

        next_offset = offset + limit
        next_cursor = str(next_offset) if next_offset < total else None
        return FeedResponse(items=items, next_cursor=next_cursor)

    # seed なしフォールバック: ID順ページネーション
    movies, total = await get_movies_paginated(db, offset=offset, limit=limit)
    items = [_to_card(m) for m in movies]
    next_offset = offset + limit
    next_cursor = str(next_offset) if next_offset < total else None
    return FeedResponse(items=items, next_cursor=next_cursor)
