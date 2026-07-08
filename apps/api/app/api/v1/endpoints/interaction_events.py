"""POST /api/v1/interaction-events

`/events` と分離した、リッチな再生 / インタラクション計測用エンドポイント。
語彙は `ALLOWED_INTERACTION_EVENTS` で制限し、未知名は 400 で弾く。
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.rate_limit import EventRateLimiter, get_event_rate_limiter
from app.db.session import get_db
from app.repositories.interaction_event_repository import (
    ALLOWED_INTERACTION_EVENTS,
    insert_interaction_event,
)
from app.schemas.interaction_event import InteractionEventAck, InteractionEventCreate


# metadata の防御的な上限。JSONB に任意ネストの巨大 JSON を保存されると
# ストレージ / クエリコストが膨らむため、キー数だけでなく「直列化後のバイト数」
# と「ネスト深さ」も制限する。
_METADATA_MAX_KEYS = 32
_METADATA_MAX_BYTES = 4096
_METADATA_MAX_DEPTH = 4


def _json_depth(value: Any, _current: int = 1) -> int:
    """dict / list のネスト深さを返す (スカラは 0、最上位 dict/list は 1)。"""
    if isinstance(value, dict):
        if not value:
            return _current
        return max(_json_depth(v, _current + 1) for v in value.values())
    if isinstance(value, list):
        if not value:
            return _current
        return max(_json_depth(v, _current + 1) for v in value)
    return _current - 1


def _validate_metadata(metadata: dict[str, Any] | None) -> None:
    """metadata の防御的なサイズ / 深さチェック。超過時は 400 を投げる。"""
    if metadata is None:
        return
    if len(metadata) > _METADATA_MAX_KEYS:
        raise HTTPException(status_code=400, detail="metadata too large")
    # 直列化してバイト数と JSON 妥当性を同時に確認する。
    try:
        encoded = json.dumps(metadata, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError) as e:
        raise HTTPException(status_code=400, detail="metadata not serializable") from e
    if len(encoded.encode("utf-8")) > _METADATA_MAX_BYTES:
        raise HTTPException(status_code=400, detail="metadata too large")
    if _json_depth(metadata) > _METADATA_MAX_DEPTH:
        raise HTTPException(status_code=400, detail="metadata too deeply nested")


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

    # metadata は PII を含めないよう、サイズ (キー数 / バイト数 / 深さ) を
    # 控えめに制限する。
    metadata = payload.metadata
    _validate_metadata(metadata)

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
