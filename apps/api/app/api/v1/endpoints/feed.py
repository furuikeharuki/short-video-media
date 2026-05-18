from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.schemas.feed import FeedResponse
from app.services.feed_service import get_feed_paginated

router = APIRouter()


@router.get("/feed", response_model=FeedResponse)
async def feed(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    seed: int | None = Query(default=None),
    genres: list[str] = Query(default=[]),
    # --- 詳細検索パラメータ (検索結果と同名で揃える) ---
    q: str | None = Query(default=None),
    actresses: list[str] = Query(default=[]),
    series_list: list[str] = Query(default=[]),
    directors: list[str] = Query(default=[]),
    makers: list[str] = Query(default=[]),
    labels: list[str] = Query(default=[]),
    ng_words: list[str] = Query(default=[]),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> FeedResponse:
    return await get_feed_paginated(
        db,
        offset=offset,
        limit=limit,
        seed=seed,
        genres=genres if genres else None,
        q=(q.strip() if q else None) or None,
        actresses=actresses or None,
        series_list=series_list or None,
        directors=directors or None,
        makers=makers or None,
        labels=labels or None,
        ng_words=ng_words or None,
        date_from=date_from,
        date_to=date_to,
    )
