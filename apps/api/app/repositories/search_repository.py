from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.movie import Movie
from app.db.models.actress import Actress
from app.db.models.genre import Genre


async def search_movies(db: AsyncSession, query: str) -> list[Movie]:
    """title / description / actress.name / genre.name の部分一致検索"""
    q = f"%{query}%"

    actress_sub = (
        select(Movie.id)
        .join(Movie.actresses)
        .where(Actress.name.ilike(q))
    )
    genre_sub = (
        select(Movie.id)
        .join(Movie.genres)
        .where(Genre.name.ilike(q))
    )

    stmt = (
        select(Movie)
        .where(
            or_(
                Movie.title.ilike(q),
                Movie.description.ilike(q),
                Movie.id.in_(actress_sub),
                Movie.id.in_(genre_sub),
            )
        )
        .order_by(Movie.title)
    )

    result = await db.execute(stmt)
    return list(result.scalars().unique().all())
