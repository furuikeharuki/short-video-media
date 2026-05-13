import random
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
    """
    offset/limit ページネーション。
    seed を指定すると PostgreSQL の setseed+random() で再現可能なランダム順。
    seed なしの場合は小スワロットプライマリキー順。
    """
    count_result = await db.execute(select(func.count()).select_from(Movie).where(Movie.is_visible == True))
    total = count_result.scalar_one()

    if seed is not None:
        # PostgreSQL: setseed でセッション内安定ソート
        await db.execute(func.setseed(seed / 2147483647.0))
        query = (
            select(Movie)
            .where(Movie.is_visible == True)
            .order_by(func.random())
            .offset(offset)
            .limit(limit)
        )
    else:
        query = (
            select(Movie)
            .where(Movie.is_visible == True)
            .order_by(Movie.created_at.desc())
            .offset(offset)
            .limit(limit)
        )

    result = await db.execute(query)
    return list(result.scalars().all()), total
