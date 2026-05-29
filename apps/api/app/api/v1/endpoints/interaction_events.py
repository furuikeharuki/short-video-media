"""POST /api/v1/interaction-events

`/events` と分離した、リッチな再生 / インタラクション計測用エンドポイント。
語彙は `ALLOWED_INTERACTION_EVENTS` で制限し、未知名は 400 で弾く。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.rate_limit import EventRateLimiter, get_event_rate_limiter
from app.db.session import get_db
from app.repositories.interaction_event_repository import (
    ALLOWED_INTERACTION_EVENTS,
    insert_interaction_event,
)
from app.schemas.interaction_event import InteractionEventAck, InteractionEventCreate


router = APIRouter()


@router.post("/interaction-events", response_model=InteractionEventAck)
async def create_interaction_event(
    payload: InteractionEventCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    limiter: EventRateLimiter = Depends(get_event_rate_limiter),
) -> InteractionEventAck:
    # `/events` と同じ既存リミッタを流用する。動画 1 本につき
    # impression + play + 4 milestone + complete などやや増えるが、
    # フロント側のデデュープと sendBeacon キープアライブで吸収する想定。
    limiter.check(request)

    if payload.event_name not in ALLOWED_INTERACTION_EVENTS:
        raise HTTPException(status_code=400, detail="invalid event_name")

    # metadata は PII を含めないよう、サイズも控えめに制限する。
    metadata = payload.metadata
    if metadata is not None and len(metadata) > 32:
        raise HTTPException(status_code=400, detail="metadata too large")

    await insert_interaction_event(
        db,
        event_name=payload.event_name,
        slug=payload.slug,
        feed_session_id=payload.feed_session_id,
        feed_position=payload.feed_position,
        session_seq=payload.session_seq,
        surface=payload.surface,
        rec_source=payload.rec_source,
        progress_ratio=payload.progress_ratio,
        progress_milestone=payload.progress_milestone,
        current_time_sec=payload.current_time_sec,
        duration_sec=payload.duration_sec,
        elapsed_ms=payload.elapsed_ms,
        direction=payload.direction,
        metadata=metadata,
    )
    return InteractionEventAck(ok=True)
