from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.movie import Movie


async def get_all_movies(db: AsyncSession) -> list[Movie]:
    result = await db.execute(select(Movie))
    return list(result.scalars().all())


async def get_movie_by_slug(db: AsyncSession, slug: str) -> Movie | None:
    result = await db.execute(select(Movie).where(Movie.slug == slug))
    return result.scalar_one_or_none()
