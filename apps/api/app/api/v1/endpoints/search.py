from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.schemas.search import SearchResponse
from app.services.search_service import search, search_by_exact_field

router = APIRouter()


@router.get("/search", response_model=SearchResponse)
async def search_movies(
    q: str | None = Query(default=None, description="検索ワード (部分一致)"),
    director: str | None = Query(default=None, description="監督名 (完全一致)"),
    maker: str | None = Query(default=None, description="メーカー名 (完全一致)"),
    label: str | None = Query(default=None, description="レーベル名 (完全一致)"),
    db: AsyncSession = Depends(get_db),
) -> SearchResponse:
    # 完全一致検索がひとつでも指定されていたらそちらを優先
    if director or maker or label:
        return await search_by_exact_field(
            db, director=director, maker=maker, label=label,
        )

    if not q:
        raise HTTPException(
            status_code=400,
            detail="q, director, maker, label のいずれかを指定してください",
        )
    return await search(db, q)
