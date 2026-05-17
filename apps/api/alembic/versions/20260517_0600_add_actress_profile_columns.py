"""add actress profile columns from DMM actress API

Revision ID: 8a3c1f2e9d04
Revises: 4f81a2b95c0e
Create Date: 2026-05-17 06:00:00.000000+00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "8a3c1f2e9d04"
down_revision: Union[str, None] = "4f81a2b95c0e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("actresses", sa.Column("ruby",            sa.String(), nullable=True))
    op.add_column("actresses", sa.Column("bust",            sa.Integer(), nullable=True))
    op.add_column("actresses", sa.Column("cup",             sa.String(), nullable=True))
    op.add_column("actresses", sa.Column("waist",           sa.Integer(), nullable=True))
    op.add_column("actresses", sa.Column("hip",             sa.Integer(), nullable=True))
    op.add_column("actresses", sa.Column("height",          sa.Integer(), nullable=True))
    op.add_column("actresses", sa.Column("birthday",        sa.Date(),   nullable=True))
    op.add_column("actresses", sa.Column("blood_type",      sa.String(), nullable=True))
    op.add_column("actresses", sa.Column("hobby",           sa.String(), nullable=True))
    op.add_column("actresses", sa.Column("prefectures",     sa.String(), nullable=True))
    op.add_column("actresses", sa.Column("image_url_small", sa.String(), nullable=True))
    op.add_column("actresses", sa.Column("image_url_large", sa.String(), nullable=True))
    op.add_column("actresses", sa.Column("dmm_list_url",    sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("actresses", "dmm_list_url")
    op.drop_column("actresses", "image_url_large")
    op.drop_column("actresses", "image_url_small")
    op.drop_column("actresses", "prefectures")
    op.drop_column("actresses", "hobby")
    op.drop_column("actresses", "blood_type")
    op.drop_column("actresses", "birthday")
    op.drop_column("actresses", "height")
    op.drop_column("actresses", "hip")
    op.drop_column("actresses", "waist")
    op.drop_column("actresses", "cup")
    op.drop_column("actresses", "bust")
    op.drop_column("actresses", "ruby")
