"""add watch_count partial indexes on interaction_events

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-05-30 00:00:00.000000+00:00

watch_count (50% 以上再生に到達したユニーク feed_session 数) を
interaction_events から都度集計するため、以下のクエリを高速化する
部分インデックスを追加する:

  - 1 作品単位:
      WHERE slug = ?
        AND (event_name='video_complete'
             OR (event_name='play_progress' AND (progress_milestone >= 50 OR progress_ratio >= 0.5)))
  - 全期間人気ランキング (slug 単位 GROUP BY):
      WHERE event_name IN ('play_progress','video_complete') AND slug IS NOT NULL
        AND (上記 50% 条件)

watch event の母集団は全 interaction_events のごく一部 (ライフサイクルの中で
50% 到達は再生失敗・離脱・ミュート等を除いたユーザーのみ) のため、partial
index にして読み書きコストを抑える。

長期的には:
  - 集計結果を movies.watch_count に non-blocking で書き戻すバッチを増設し、
    詳細・ランキングともに O(1) 参照にするのが望ましい (フォローアップ)。
"""
from typing import Sequence, Union

from alembic import op


revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1 作品 (slug) 単位の watch_count 集計用:
    #   COUNT(DISTINCT feed_session_id) FILTERED BY watch event 条件。
    # slug をリーディングカラムにし、watch event 行のみインデックスへ格納する。
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_interaction_events_watch_slug
            ON interaction_events (slug, feed_session_id)
         WHERE event_name = 'video_complete'
            OR (event_name = 'play_progress'
                AND (progress_milestone >= 50 OR progress_ratio >= 0.5))
        """
    )
    # ランキング (全期間 watch_count 順) 用: slug NULL を除いた watch event の
    # サブセットを feed_session 込みで保持し、GROUP BY slug + COUNT(DISTINCT) を
    # index-only スキャンに寄せる。
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


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_interaction_events_watch_all")
    op.execute("DROP INDEX IF EXISTS ix_interaction_events_watch_slug")
