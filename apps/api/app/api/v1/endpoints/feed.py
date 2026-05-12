from fastapi import APIRouter

from app.schemas.feed import FeedResponse
from app.services.feed_service import get_feed

router = APIRouter()


@router.get("/feed", response_model=FeedResponse)
def read_feed() -> FeedResponse:
    return get_feed()