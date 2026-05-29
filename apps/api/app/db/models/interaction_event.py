"""動画フィード上のインタラクションイベント。

既存 `events` テーブル (view/play/detail_click/affiliate_click/search の集計用)
とは別に、レコメンド学習や SEO 用途で必要なリッチな再生イベントを薄く受ける。

設計方針:
  - PII を取らない (IP / device fingerprint は保持しない)。
  - `session_id` はクライアント側で発行する UUID/ULID。サーバーで生成しない。
  - 柔軟なスキーマ拡張に耐えるため、固定カラム + `metadata` JSONB で受ける。
  - 集計に頻出する `event_name + created_at` / `slug + event_name` に index。
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Float, Index, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class InteractionEvent(Base):
    __tablename__ = "interaction_events"
    __table_args__ = (
        Index("ix_interaction_events_name_created", "event_name", "created_at"),
        Index("ix_interaction_events_slug_name", "slug", "event_name"),
        Index("ix_interaction_events_session", "feed_session_id"),
    )

    id: Mapped[str] = mapped_column(
        primary_key=True, default=lambda: str(uuid.uuid4())
    )
    # impression / play / play_progress / video_complete / pause / resume /
    # mute / unmute / skip / swipe / replay / dwell / page_hidden 等。
    # ALLOWED_INTERACTION_EVENTS と一致させること。
    event_name: Mapped[str] = mapped_column(String(48), index=True)

    # 対象作品の slug (impression や play 系で必須)。検索系の interaction では NULL。
    slug: Mapped[str | None] = mapped_column(String(255), index=True)

    # クライアント発行のフィード閲覧セッション ID (例: feed_<uuid>)。
    feed_session_id: Mapped[str | None] = mapped_column(String(64))
    # フィード内 0-indexed position。広告込みのスライド index ではなく
    # 動画のみで数えた position を期待する。
    feed_position: Mapped[int | None] = mapped_column(Integer)
    # セッション内で何回目に発生したイベントか。
    session_seq: Mapped[int | None] = mapped_column(Integer)

    # フィードの種類 ("home" / "search" / "actress" / "tag" / "ranking" 等)。
    surface: Mapped[str | None] = mapped_column(String(32))
    # レコメンドソース ("ranking_daily" / "search:tag=xxx" / "actress:slug" 等)。
    rec_source: Mapped[str | None] = mapped_column(String(128))

    # 進捗 0..1。video_complete / play_progress / skip 等で記録。
    progress_ratio: Mapped[float | None] = mapped_column(Float)
    # マイルストーン (25 / 50 / 75 / 100) を整数で。
    progress_milestone: Mapped[int | None] = mapped_column(Integer)
    # 現在再生位置 (秒)。
    current_time_sec: Mapped[float | None] = mapped_column(Float)
    # 動画 duration (秒)。
    duration_sec: Mapped[float | None] = mapped_column(Float)
    # この event 発生までに経過した時間 (ms)。dwell 集計用。
    elapsed_ms: Mapped[int | None] = mapped_column(Integer)

    # 方向 (skip/swipe で "prev"/"next"/"left"/"right" 等)。
    direction: Mapped[str | None] = mapped_column(String(16))

    # 自由形式の追加情報。volume, muted, network_type, prev_slug, page hidden 理由など。
    event_metadata: Mapped[dict | None] = mapped_column(JSONB, name="metadata")

    # TIMESTAMP WITHOUT TIME ZONE (events テーブルと同様、naive UTC)。
    created_at: Mapped[datetime] = mapped_column(
        default=lambda: datetime.now(timezone.utc).replace(tzinfo=None),
        server_default=func.now(),
        index=True,
    )
