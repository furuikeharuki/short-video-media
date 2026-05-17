from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.schemas.movie import MovieCard
from app.services.ranking_service import VALID_PERIODS, get_ranking

router = APIRouter()


@router.get("/rankings", response_model=list[MovieCard])
async def read_ranking(
    period: str = Query(default="weekly"),
    limit: int = Query(default=20, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
) -> list[MovieCard]:
    if period not in VALID_PERIODS:
        raise HTTPException(
            status_code=400,
            detail=f"period must be one of {VALID_PERIODS}",
        )
    return await get_ranking(db, period=period, limit=limit)
