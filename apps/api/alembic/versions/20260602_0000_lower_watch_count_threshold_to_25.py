"""lower watch_count threshold from 50% to 25% (rebuild partial indexes)

Revision ID: 71fc7c116334
Revises: 5e1c8b2a90f4
Create Date: 2026-06-02 00:00:00.000000+00:00

watch_count (= 一定割合以上再生に到達したユニーク feed_session 数) の閾値を
50% から 25% に引き下げる。クエリ側 (`_watch_event_filter`) は
progress_milestone >= 25 / progress_ratio >= 0.25 を見るように変更済み。

部分インデックス (ix_interaction_events_watch_slug / _watch_all) は
WHERE 述語に 50% 条件を埋め込んでいるため、述語が新しいクエリ条件と
一致しなくなると Postgres がこれらを使えなくなる。インデックスを
25% 述語で作り直し、引き続き watch_count 集計をカバーさせる。

フロントは元から 25/50/75 マイルストーンを送出しているため、既存の
interaction_events をそのまま再利用でき、データのバックフィルは不要。
25% / 49% など従来 watch ではなかった既存行が、本マイグレーション後は
watch として数えられるようになる (= 過去分も遡って 25% 基準で集計される)。
"""
from typing import Sequence, Union

from alembic import op


revision: str = "71fc7c116334"
down_revision: Union[str, None] = "5e1c8b2a90f4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 旧 50% 述語の部分インデックスを落として 25% 述語で作り直す。
    op.execute("DROP INDEX IF EXISTS ix_interaction_events_watch_slug")
    op.execute("DROP INDEX IF EXISTS ix_interaction_events_watch_all")
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_interaction_events_watch_slug
            ON interaction_events (slug, feed_session_id)
         WHERE event_name = 'video_complete'
            OR (event_name = 'play_progress'
                AND (progress_milestone >= 25 OR progress_ratio >= 0.25))
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_interaction_events_watch_all
            ON interaction_events (slug, feed_session_id)
         WHERE slug IS NOT NULL
           AND (event_name = 'video_complete'
                OR (event_name = 'play_progress'
                    AND (progress_milestone >= 25 OR progress_ratio >= 0.25)))
        """
    )


def downgrade() -> None:
    # 50% 述語の部分インデックスに戻す (2b8d1e0f7a34 と同一定義)。
    op.execute("DROP INDEX IF EXISTS ix_interaction_events_watch_slug")
    op.execute("DROP INDEX IF EXISTS ix_interaction_events_watch_all")
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
