"""interaction_events 永続化レイヤ。"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.interaction_event import InteractionEvent


# クライアントから受け付ける event_name の語彙。schemas 側の Pydantic で
# 長さチェックはしているが、未知の名前で DB が汚れるのを防ぐためここで限定する。
# 増やすときは frontend `analytics/interactions.ts` と一緒に更新する。
ALLOWED_INTERACTION_EVENTS: set[str] = {
    # 表示系
    "impression",
    # 再生ライフサイクル
    "play",
    "play_progress",
    "video_complete",
    "pause",
    "resume",
    "replay",
    "dwell",
    # スワイプ / スキップ
    "skip",
    "swipe",
    # 音量
    "mute",
    "unmute",
    # ページライフサイクル
    "page_hidden",
    "page_visible",
}


async def insert_interaction_event(
    db: AsyncSession,
    *,
    event_name: str,
    slug: str | None = None,
    feed_session_id: str | None = None,
    feed_position: int | None = None,
    session_seq: int | None = None,
    surface: str | None = None,
    rec_source: str | None = None,
    progress_ratio: float | None = None,
    progress_milestone: int | None = None,
    current_time_sec: float | None = None,
    duration_sec: float | None = None,
    elapsed_ms: int | None = None,
    direction: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> InteractionEvent:
    ev = InteractionEvent(
        event_name=event_name,
        slug=slug,
        feed_session_id=feed_session_id,
        feed_position=feed_position,
        session_seq=session_seq,
        surface=surface,
        rec_source=rec_source,
        progress_ratio=progress_ratio,
        progress_milestone=progress_milestone,
        current_time_sec=current_time_sec,
        duration_sec=duration_sec,
        elapsed_ms=elapsed_ms,
        direction=direction,
        event_metadata=metadata,
    )
    db.add(ev)
    await db.commit()
    return ev
