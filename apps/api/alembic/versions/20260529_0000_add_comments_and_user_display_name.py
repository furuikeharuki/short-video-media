"""add comments table + users.display_name

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-05-29 00:00:00.000000+00:00

YouTube 風コメント機能のための DB 永続化:
  - users.display_name (String(32), NULL 許容) を追加。
    NULL のとき API 側で「名無しのユーザー」として扱う。
  - comments テーブルを新規作成。
    movie_id / parent_id (自己参照) / author_user_id / display_name_snapshot /
    body / created_at を持ち、movie ごと・スレッドごとの索引を張る。

ON DELETE 方針:
  - movie 削除 → コメントごと CASCADE 削除
  - 親コメント削除 → 子コメントも CASCADE 削除 (YouTube と同じ挙動)
  - ユーザー削除 → コメントは残し author_user_id を NULL に SET
    (display_name_snapshot がスナップショットとして残るので「名無しのユーザー」
     表記に巻き戻らない)
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "f6a7b8c9d0e1"
down_revision: Union[str, None] = "e5f6a7b8c9d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("display_name", sa.String(length=32), nullable=True),
    )
    op.create_table(
        "comments",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "movie_id",
            sa.String(),
            sa.ForeignKey("movies.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "parent_id",
            sa.String(),
            sa.ForeignKey("comments.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "author_user_id",
            sa.String(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("display_name_snapshot", sa.String(length=32), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=False),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_comments_movie_created", "comments", ["movie_id", "created_at"]
    )
    op.create_index(
        "ix_comments_parent_created", "comments", ["parent_id", "created_at"]
    )
    op.create_index(
        "ix_comments_author_user_id", "comments", ["author_user_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_comments_author_user_id", table_name="comments")
    op.drop_index("ix_comments_parent_created", table_name="comments")
    op.drop_index("ix_comments_movie_created", table_name="comments")
    op.drop_table("comments")
    op.drop_column("users", "display_name")
