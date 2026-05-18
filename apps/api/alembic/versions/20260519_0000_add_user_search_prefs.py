"""add user_search_prefs table

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-05-19 00:00:00.000000+00:00

ユーザーごとに「最後に適用した検索条件」を 1 件サーバ保存するためのテーブル。
検索結果ページを再訪したときに前回の絞り込みを自動復元するのが目的。

設計メモ:
  - user_id を PK にして 1 ユーザー 1 レコード
  - payload は JSONB。フロントが URL に組み立てる構造をそのまま入れる
    (Web 側のスキーマと整合させやすく、後で項目が増えても破壊的変更が要らない)
  - ON DELETE CASCADE で User 削除時に連動して消える
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "d4e5f6a7b8c9"
down_revision: Union[str, None] = "c3d4e5f6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_search_prefs",
        sa.Column(
            "user_id",
            sa.String(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "payload",
            sa.dialects.postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=False),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_table("user_search_prefs")
