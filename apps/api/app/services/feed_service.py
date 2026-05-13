from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.movie_repository import get_all_movies, get_movies_paginated
from app.schemas.feed import FeedResponse
from app.schemas.movie import MovieCard


async def get_feed(db: AsyncSession) -> FeedResponse:
    movies = await get_all_movies(db)
    items = [
        MovieCard(
            id=movie.id,
            title=movie.title,
            slug=movie.slug,
            thumbnail_url=movie.thumbnail_url,
            sample_video_url=movie.sample_video_url,
            sample_embed_url=movie.sample_embed_url,
            actresses=[p.name for p in movie.performers],
            genres=[g.name for g in movie.genres],
            affiliate_url=movie.affiliate_url,
        )
        for movie in movies
    ]
    return FeedResponse(items=items, next_cursor=None)


async def get_feed_paginated(
    db: AsyncSession,
    offset: int = 0,
    limit: int = 20,
    seed: int | None = None,
) -> FeedResponse:
    movies, total = await get_movies_paginated(db, offset=offset, limit=limit, seed=seed)

    items = [
        MovieCard(
            id=str(movie.id),
            title=movie.title,
            slug=movie.slug,
            thumbnail_url=movie.thumbnail_url,
            sample_video_url=movie.sample_video_url,
            sample_embed_url=movie.sample_embed_url,
            actresses=[p.name for p in movie.performers],
            genres=[g.name for g in movie.genres],
            affiliate_url=movie.affiliate_url,
        )
        for movie in movies
    ]

    next_offset = offset + limit
    # 全周完了時は next_cursor=None を返しフロントがリセットを検知できるようにする
    next_cursor = str(next_offset) if next_offset < total else None

    return FeedResponse(items=items, next_cursor=next_cursor)
