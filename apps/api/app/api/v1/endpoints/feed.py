from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.db import get_db
from app.schemas.feed import FeedResponse
from app.services.feed_service import get_feed_paginated

router = APIRouter()


@router.get("/feed", response_model=FeedResponse)
async def feed(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    seed: int | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> FeedResponse:
    """
    フィード取得。offset/limit ページネーション。
    seed を指定すると同一セッション内で再現可能なランダム順。
    """
    return await get_feed_paginated(db, offset=offset, limit=limit, seed=seed)
