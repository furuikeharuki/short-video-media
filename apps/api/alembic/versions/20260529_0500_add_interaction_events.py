"""add interaction_events table

Revision ID: a1b2c3d4e5f6
Revises: f6a7b8c9d0e1
Create Date: 2026-05-29 05:00:00.000000+00:00

レコメンド学習 + SEO 用途のリッチな動画イベント受け口。
PII を取らない設計: IP / 生 device-id は保持せず、
client から発行された feed_session_id をキーにして関連付ける。

`metadata` カラムは JSONB の自由形式。volume / muted / network_type /
prev_slug など、固定カラムにするほどでもない補足情報をここに乗せる。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, None] = "f6a7b8c9d0e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "interaction_events",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("event_name", sa.String(length=48), nullable=False),
        sa.Column("slug", sa.String(length=255), nullable=True),
        sa.Column("feed_session_id", sa.String(length=64), nullable=True),
        sa.Column("feed_position", sa.Integer(), nullable=True),
        sa.Column("session_seq", sa.Integer(), nullable=True),
        sa.Column("surface", sa.String(length=32), nullable=True),
        sa.Column("rec_source", sa.String(length=128), nullable=True),
        sa.Column("progress_ratio", sa.Float(), nullable=True),
        sa.Column("progress_milestone", sa.Integer(), nullable=True),
        sa.Column("current_time_sec", sa.Float(), nullable=True),
        sa.Column("duration_sec", sa.Float(), nullable=True),
        sa.Column("elapsed_ms", sa.Integer(), nullable=True),
        sa.Column("direction", sa.String(length=16), nullable=True),
        sa.Column("metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_interaction_events_event_name"),
        "interaction_events",
        ["event_name"],
        unique=False,
    )
    op.create_index(
        op.f("ix_interaction_events_slug"),
        "interaction_events",
        ["slug"],
        unique=False,
    )
    op.create_index(
        op.f("ix_interaction_events_created_at"),
        "interaction_events",
        ["created_at"],
        unique=False,
    )
    op.create_index(
        "ix_interaction_events_name_created",
        "interaction_events",
        ["event_name", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_interaction_events_slug_name",
        "interaction_events",
        ["slug", "event_name"],
        unique=False,
    )
    op.create_index(
        "ix_interaction_events_session",
        "interaction_events",
        ["feed_session_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_interaction_events_session", table_name="interaction_events")
    op.drop_index("ix_interaction_events_slug_name", table_name="interaction_events")
    op.drop_index("ix_interaction_events_name_created", table_name="interaction_events")
    op.drop_index(
        op.f("ix_interaction_events_created_at"), table_name="interaction_events"
    )
    op.drop_index(op.f("ix_interaction_events_slug"), table_name="interaction_events")
    op.drop_index(
        op.f("ix_interaction_events_event_name"), table_name="interaction_events"
    )
    op.drop_table("interaction_events")
