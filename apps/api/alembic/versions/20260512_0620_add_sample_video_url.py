"""add sample_video_url to movies

Revision ID: a1b2c3d4e5f6
Revises: 8965394ad436
Create Date: 2026-05-12 06:20:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: str | None = "8965394ad436"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "movies",
        sa.Column("sample_video_url", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("movies", "sample_video_url")
