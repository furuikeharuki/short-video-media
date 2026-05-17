"""add composite indexes for feed/ranking queries

Revision ID: 6c7d92a4f1b8
Revises: 8a3c1f2e9d04
Create Date: 2026-05-18 01:00:00.000000+00:00

主なクエリパターン:
  - フィード/ホーム: WHERE is_visible = TRUE ORDER BY primary_date DESC
  - ランキング: WHERE is_visible = TRUE ORDER BY review_count DESC
  - イベント集計: WHERE event_type = ? AND created_at >= ?

これらを 1 つの index で完結できるよう、複合 index を追加する。
既存の単一カラム index は他のクエリ (slug / content_id 単独 lookup など) で
使うため残す。

CREATE INDEX CONCURRENTLY は Alembic のトランザクション制御と相性が悪いので、
オフピーク帯にマイグレーションを流す前提で通常の CREATE INDEX を使う。
本番テーブル規模 (数万行) なら数秒で完了する想定。
"""
from typing import Sequence, Union

from alembic import op


revision: str = "6c7d92a4f1b8"
down_revision: Union[str, None] = "8a3c1f2e9d04"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # フィードの新着順 (is_visible AND primary_date DESC)
    op.create_index(
        "ix_movies_visible_primary_date",
        "movies",
        ["is_visible", "primary_date"],
        postgresql_using="btree",
    )
    # ランキング (is_visible AND review_count DESC)
    op.create_index(
        "ix_movies_visible_review_count",
        "movies",
        ["is_visible", "review_count"],
        postgresql_using="btree",
    )
    # 集計クエリ (event_type ごとの直近 N 件 / N 時間)
    op.create_index(
        "ix_events_type_created",
        "events",
        ["event_type", "created_at"],
        postgresql_using="btree",
    )


def downgrade() -> None:
    op.drop_index("ix_events_type_created", table_name="events")
    op.drop_index("ix_movies_visible_review_count", table_name="movies")
    op.drop_index("ix_movies_visible_primary_date", table_name="movies")
