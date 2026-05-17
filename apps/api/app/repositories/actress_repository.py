from collections import Counter

from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.actress import Actress
from app.db.models.movie import Movie


async def get_actress_by_name(db: AsyncSession, name: str) -> Actress | None:
    """女優名完全一致で 1 件取得。"""
    stmt = select(Actress).where(Actress.name == name).limit(1)
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def get_actress_by_slug(db: AsyncSession, slug: str) -> Actress | None:
    """slug で 1 件取得。"""
    stmt = select(Actress).where(Actress.slug == slug).limit(1)
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def get_movies_by_actress_id(
    db: AsyncSession,
    actress_id: int,
    *,
    limit: int = 60,
) -> list[Movie]:
    """指定女優の出演作品を、配信日 (primary_date) 降順で返す。"""
    stmt = (
        select(Movie)
        .join(Movie.actresses)
        .where(
            Actress.id == actress_id,
            Movie.is_visible.is_(True),
        )
        .order_by(
            desc(Movie.primary_date),
            desc(Movie.review_count),
            Movie.id,
        )
        .limit(limit)
    )
    result = await db.execute(stmt)
    return list(result.scalars().unique().all())


def aggregate_actress_stats(movies: list[Movie]) -> dict:
    """出演作品リストから集計値を算出。"""
    movie_count = len(movies)
    total_review = 0
    weighted_sum = 0.0
    weighted_n = 0
    genre_counter: Counter[str] = Counter()
    maker_counter: Counter[str] = Counter()

    for m in movies:
        rc = m.review_count or 0
        total_review += rc
        if m.review_average is not None and rc > 0:
            weighted_sum += float(m.review_average) * rc
            weighted_n += rc
        for g in m.genres:
            genre_counter[g.name] += 1
        if m.maker_name:
            maker_counter[m.maker_name] += 1

    average_review: float | None = None
    if weighted_n > 0:
        average_review = round(weighted_sum / weighted_n, 2)

    return {
        "movie_count": movie_count,
        "total_review_count": total_review,
        "average_review": average_review,
        "top_genres": [g for g, _ in genre_counter.most_common(8)],
        "top_makers": [m for m, _ in maker_counter.most_common(5)],
    }
