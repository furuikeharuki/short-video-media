from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.schemas.feed import FeedResponse
from app.services.feed_service import get_feed

router = APIRouter()


@router.get("/feed", response_model=FeedResponse)
async def read_feed(db: AsyncSession = Depends(get_db)) -> FeedResponse:
    return await get_feed(db)
