from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.movie import Movie
from app.db.models.genre import Genre


async def get_movie_by_slug(db: AsyncSession, slug: str) -> Movie | None:
    result = await db.execute(select(Movie).where(Movie.slug == slug))
    return result.scalar_one_or_none()


async def get_all_movie_ids(db: AsyncSession, genres: list[str] | None = None) -> list[str]:
    """全IDを取得。genresが指定された場合はOR条件で絞り込む。"""
    if genres:
        query = (
            select(Movie.id)
            .join(Movie.genres)
            .where(Genre.name.in_(genres))
            .distinct()
            .order_by(Movie.id)
        )
    else:
        query = select(Movie.id).order_by(Movie.id)
    result = await db.execute(query)
    return list(result.scalars().all())


async def get_movies_by_ids(db: AsyncSession, ids: list[str]) -> dict[str, Movie]:
    """指定IDの作品を一括取得し、id -> Movie の dict で返す。"""
    if not ids:
        return {}
    result = await db.execute(select(Movie).where(Movie.id.in_(ids)))
    movies = result.scalars().all()
    return {m.id: m for m in movies}


async def get_movies_paginated(
    db: AsyncSession,
    offset: int = 0,
    limit: int = 20,
    genres: list[str] | None = None,
) -> tuple[list[Movie], int]:
    if genres:
        base_query = select(Movie).join(Movie.genres).where(Genre.name.in_(genres)).distinct()
        count_query = (
            select(func.count(Movie.id.distinct()))
            .join(Movie.genres)
            .where(Genre.name.in_(genres))
        )
    else:
        base_query = select(Movie)
        count_query = select(func.count()).select_from(Movie)

    count_result = await db.execute(count_query)
    total = count_result.scalar_one()

    query = base_query.order_by(Movie.id).offset(offset).limit(limit)
    result = await db.execute(query)
    return list(result.scalars().all()), total
