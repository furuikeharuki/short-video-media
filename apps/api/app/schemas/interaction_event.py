"""フィード/動画インタラクションイベントの schema。

`event_metadata` (DB の `metadata` カラム) は任意の JSON dict。
キーには PII を入れないこと (IP、メール、生 device-id など)。
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class InteractionEventCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    event_name: str = Field(..., min_length=1, max_length=48)
    slug: str | None = Field(default=None, max_length=255)

    feed_session_id: str | None = Field(default=None, max_length=64)
    feed_position: int | None = Field(default=None, ge=0, le=100_000)
    session_seq: int | None = Field(default=None, ge=0, le=1_000_000)

    surface: str | None = Field(default=None, max_length=32)
    rec_source: str | None = Field(default=None, max_length=128)

    progress_ratio: float | None = Field(default=None, ge=0.0, le=1.0)
    progress_milestone: int | None = Field(default=None, ge=0, le=100)
    current_time_sec: float | None = Field(default=None, ge=0.0, le=86_400.0)
    duration_sec: float | None = Field(default=None, ge=0.0, le=86_400.0)
    elapsed_ms: int | None = Field(default=None, ge=0, le=86_400_000)

    direction: str | None = Field(default=None, max_length=16)
    metadata: dict[str, Any] | None = Field(default=None)


class InteractionEventAck(BaseModel):
    ok: bool = True
