from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.movie import Movie
from app.db.models.actress import Actress
from app.db.models.genre import Genre


async def search_movies(db: AsyncSession, query: str) -> list[Movie]:
    """title / description / actress.name / genre.name /
    director_name / maker_name / label_name の部分一致検索"""
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
                Movie.director_name.ilike(q),
                Movie.maker_name.ilike(q),
                Movie.label_name.ilike(q),
                Movie.id.in_(actress_sub),
                Movie.id.in_(genre_sub),
            )
        )
        .order_by(Movie.title)
    )

    result = await db.execute(stmt)
    return list(result.scalars().unique().all())


async def search_movies_by_exact_field(
    db: AsyncSession,
    *,
    director: str | None = None,
    maker: str | None = None,
    label: str | None = None,
) -> list[Movie]:
    """監督 / メーカー / レーベルの完全一致検索。
    複数指定時は AND。いずれも None なら空リストを返す。
    """
    conditions = []
    if director:
        conditions.append(Movie.director_name == director)
    if maker:
        conditions.append(Movie.maker_name == maker)
    if label:
        conditions.append(Movie.label_name == label)

    if not conditions:
        return []

    stmt = select(Movie).where(*conditions).order_by(Movie.delivery_date.desc().nullslast())
    result = await db.execute(stmt)
    return list(result.scalars().unique().all())
