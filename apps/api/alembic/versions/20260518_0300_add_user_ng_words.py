"""add user_ng_words table

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-05-18 03:00:00.000000+00:00

検索エンドポイント (/api/v1/search) の "詳細絞り込み" 機能で使う、ユーザー単位の
NG ワード保存テーブル。クライアントが ng_words クエリを未指定でも、ログイン中
ユーザーには自動で適用されるようにするためサーバ側で保持する。

- user_id + word を複合 PK にして重複を防ぐ
- ユーザー削除に連動して NG ワードも消えるよう ON DELETE CASCADE
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "c3d4e5f6a7b8"
down_revision: Union[str, None] = "b2c3d4e5f6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_ng_words",
        sa.Column(
            "user_id",
            sa.String(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("word", sa.String(length=64), primary_key=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=False),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_table("user_ng_words")
