"""add user, identity, bookmark, view_history tables

Revision ID: 4f81a2b95c0e
Revises: 027a75b9c90d
Create Date: 2026-05-17 05:00:00.000000+00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "4f81a2b95c0e"
down_revision: Union[str, None] = "027a75b9c90d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # users
    op.create_table(
        "users",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=False),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=False),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    # identities (provider + sub_hash で一意)
    op.create_table(
        "identities",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("sub_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=False),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("provider", "sub_hash", name="uq_identity_provider_sub"),
    )
    op.create_index(op.f("ix_identities_user_id"), "identities", ["user_id"])
    op.create_index(op.f("ix_identities_provider"), "identities", ["provider"])
    op.create_index(op.f("ix_identities_sub_hash"), "identities", ["sub_hash"])

    # bookmarks (user_id + movie_id 複合 PK)
    op.create_table(
        "bookmarks",
        sa.Column(
            "user_id",
            sa.String(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "movie_id",
            sa.String(),
            sa.ForeignKey("movies.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=False),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(op.f("ix_bookmarks_created_at"), "bookmarks", ["created_at"])

    # view_histories (user_id + movie_id 複合 PK、最終視聴日時と回数を保持)
    op.create_table(
        "view_histories",
        sa.Column(
            "user_id",
            sa.String(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "movie_id",
            sa.String(),
            sa.ForeignKey("movies.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "last_viewed_at",
            sa.DateTime(timezone=False),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "view_count",
            sa.Integer(),
            server_default="1",
            nullable=False,
        ),
    )
    op.create_index(
        op.f("ix_view_histories_last_viewed_at"),
        "view_histories",
        ["last_viewed_at"],
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_view_histories_last_viewed_at"), table_name="view_histories")
    op.drop_table("view_histories")
    op.drop_index(op.f("ix_bookmarks_created_at"), table_name="bookmarks")
    op.drop_table("bookmarks")
    op.drop_index(op.f("ix_identities_sub_hash"), table_name="identities")
    op.drop_index(op.f("ix_identities_provider"), table_name="identities")
    op.drop_index(op.f("ix_identities_user_id"), table_name="identities")
    op.drop_table("identities")
    op.drop_table("users")
