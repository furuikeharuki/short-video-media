from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.schemas.search import SearchResponse
from app.services.search_service import search

router = APIRouter()


@router.get("/search", response_model=SearchResponse)
async def search_movies(
    q: str = Query(..., min_length=1, description="検索ワード"),
    db: AsyncSession = Depends(get_db),
) -> SearchResponse:
    return await search(db, q)
