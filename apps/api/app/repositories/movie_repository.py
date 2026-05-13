from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.movie import Movie


async def get_all_movies(db: AsyncSession) -> list[Movie]:
    result = await db.execute(select(Movie))
    return list(result.scalars().all())


async def get_movie_by_slug(db: AsyncSession, slug: str) -> Movie | None:
    result = await db.execute(select(Movie).where(Movie.slug == slug))
    return result.scalar_one_or_none()


async def get_movies_paginated(
    db: AsyncSession,
    offset: int = 0,
    limit: int = 20,
    seed: int | None = None,
) -> tuple[list[Movie], int]:
    count_result = await db.execute(select(func.count()).select_from(Movie))
    total = count_result.scalar_one()

    if seed is not None:
        normalized = (seed % 2147483647) / 2147483647.0
        await db.execute(func.setseed(normalized))
        query = (
            select(Movie)
            .order_by(func.random())
            .offset(offset)
            .limit(limit)
        )
    else:
        query = (
            select(Movie)
            .order_by(Movie.id)
            .offset(offset)
            .limit(limit)
        )

    result = await db.execute(query)
    return list(result.scalars().all()), total
