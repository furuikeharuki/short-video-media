from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.movie import Movie
from app.db.models.genre import Genre


async def get_movie_by_slug(db: AsyncSession, slug: str) -> Movie | None:
    result = await db.execute(select(Movie).where(Movie.slug == slug))
    return result.scalar_one_or_none()


async def get_all_movie_ids(db: AsyncSession, genre: str | None = None) -> list[str]:
    """全IDを取得。genreが指定された場合はそのジャンルに絞り込む。"""
    if genre:
        query = (
            select(Movie.id)
            .join(Movie.genres)
            .where(Genre.name == genre)
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
    genre: str | None = None,
) -> tuple[list[Movie], int]:
    """
    フォールバック用（Redis未接続・seedなし時）。
    genreが指定された場合はジャンルで絞り込む。
    """
    if genre:
        base_query = select(Movie).join(Movie.genres).where(Genre.name == genre)
        count_query = select(func.count()).select_from(Movie).join(Movie.genres).where(Genre.name == genre)
    else:
        base_query = select(Movie)
        count_query = select(func.count()).select_from(Movie)

    count_result = await db.execute(count_query)
    total = count_result.scalar_one()

    query = base_query.order_by(Movie.id).offset(offset).limit(limit)
    result = await db.execute(query)
    return list(result.scalars().all()), total
