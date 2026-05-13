import random
from sqlalchemy import select, func, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.movie import Movie


async def get_all_movies(db: AsyncSession) -> list[Movie]:
    result = await db.execute(select(Movie))
    return list(result.scalars().all())


async def get_movie_by_slug(db: AsyncSession, slug: str) -> Movie | None:
    result = await db.execute(select(Movie).where(Movie.slug == slug))
    return result.scalar_one_or_none()


async def get_all_movie_ids(db: AsyncSession) -> list[str]:
    """全 ID を取得。シャッフルのための農材に使う。"""
    result = await db.execute(select(Movie.id).order_by(Movie.id))
    return list(result.scalars().all())


async def get_movies_by_ids(db: AsyncSession, ids: list[str]) -> dict[str, Movie]:
    """指定 ID の作品を一括取得し、id -> Movie の dict で返す。"""
    if not ids:
        return {}
    result = await db.execute(select(Movie).where(Movie.id.in_(ids)))
    movies = result.scalars().all()
    return {m.id: m for m in movies}


async def get_movies_paginated(
    db: AsyncSession,
    offset: int = 0,
    limit: int = 20,
    seed: int | None = None,
) -> tuple[list[Movie], int]:
    """
    フォールバック用（Redis 未接続時）。
    小規模ならこちらで十分。100k 規模になったら Redis 方式が必須。
    """
    count_result = await db.execute(select(func.count()).select_from(Movie))
    total = count_result.scalar_one()

    query = (
        select(Movie)
        .order_by(Movie.id)
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(query)
    return list(result.scalars().all()), total
