from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.rate_limit import EventRateLimiter, get_event_rate_limiter
from app.db.session import get_db
from app.repositories.event_repository import ALLOWED_EVENT_TYPES, insert_event
from app.schemas.event import EventAck, EventCreate

router = APIRouter()


@router.post("/events", response_model=EventAck)
async def create_event(
    payload: EventCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    limiter: EventRateLimiter = Depends(get_event_rate_limiter),
) -> EventAck:
    # IP ごとのレート制限（在庫スパム / 連打対策）
    limiter.check(request)

    if payload.event_type not in ALLOWED_EVENT_TYPES:
        raise HTTPException(status_code=400, detail="invalid event_type")

    # search イベントは search_query 必須
    if payload.event_type == "search" and not (payload.search_query and payload.search_query.strip()):
        raise HTTPException(status_code=400, detail="search_query is required for search event")

    # それ以外は slug 必須
    if payload.event_type != "search" and not payload.slug:
        raise HTTPException(status_code=400, detail="slug is required")

    await insert_event(
        db,
        event_type=payload.event_type,
        slug=payload.slug,
        title=payload.title,
        affiliate_url=payload.affiliate_url,
        next_path=payload.next_path,
        search_query=(payload.search_query.strip() if payload.search_query else None),
    )
    return EventAck(ok=True)
