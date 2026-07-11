"""change watch_count threshold to 10 seconds

Revision ID: b4c6d8e2f901
Revises: a7d3f9c1e204
Create Date: 2026-07-09 00:00:00.000000+00:00

watch_count の canonical 定義を「50% 以上再生」から「10 秒以上再生」に変更する。
既存の watch_count 部分インデックスも current_time_sec >= 10.0 条件へ張り替える。
"""
from typing import Sequence, Union

from alembic import op


revision: str = "b4c6d8e2f901"
down_revision: Union[str, None] = "a7d3f9c1e204"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_interaction_events_watch_all")
    op.execute("DROP INDEX IF EXISTS ix_interaction_events_watch_slug")
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_interaction_events_watch_slug
            ON interaction_events (slug, feed_session_id)
         WHERE event_name IN ('play_progress', 'video_complete')
           AND current_time_sec >= 10.0
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_interaction_events_watch_all
            ON interaction_events (slug, feed_session_id)
         WHERE slug IS NOT NULL
           AND event_name IN ('play_progress', 'video_complete')
           AND current_time_sec >= 10.0
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_interaction_events_watch_all")
    op.execute("DROP INDEX IF EXISTS ix_interaction_events_watch_slug")
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_interaction_events_watch_slug
            ON interaction_events (slug, feed_session_id)
         WHERE event_name = 'video_complete'
            OR (event_name = 'play_progress'
                AND (progress_milestone >= 50 OR progress_ratio >= 0.5))
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_interaction_events_watch_all
            ON interaction_events (slug, feed_session_id)
         WHERE slug IS NOT NULL
           AND (event_name = 'video_complete'
                OR (event_name = 'play_progress'
                    AND (progress_milestone >= 50 OR progress_ratio >= 0.5)))
        """
    )
