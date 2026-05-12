from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.genre import Genre
from app.db.models.movie import MovieGenre
from app.db.session import get_db  # feed.py と同じパス

router = APIRouter(prefix="/tags")


@router.get("/popular", response_model=list[str])
async def get_popular_tags(
    limit: int = 20,
    db: AsyncSession = Depends(get_db),
) -> list[str]:
    """
    movie_genres 中間テーブルを集計し、
    使用数が多いジャンル名上位 limit 件を返す。
    """
    stmt = (
        select(Genre.name)
        .join(MovieGenre, Genre.id == MovieGenre.genre_id)
        .group_by(Genre.id, Genre.name)
        .order_by(func.count(MovieGenre.movie_id).desc())
        .limit(limit)
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())
