"""add_missing_columns

Revision ID: add_missing_columns
Revises: fanza_schema_v2
Create Date: 2026-05-13 04:20:00.000000+00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'add_missing_columns'
down_revision: Union[str, None] = 'fanza_schema_v2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # movies: is_visible
    op.add_column('movies', sa.Column('is_visible', sa.Boolean(), server_default='true', nullable=False))

    # movies: affiliate_url_en (前マイグで追加済みの場合はスキップされる)
    # カラムが既にある場合はエラーになるので、ない場合のみ追加
    conn = op.get_bind()
    cols = [row[0] for row in conn.execute(
        sa.text("SELECT column_name FROM information_schema.columns WHERE table_name='movies' AND column_name='affiliate_url_en'")
    )]
    if 'affiliate_url_en' not in cols:
        op.add_column('movies', sa.Column('affiliate_url_en', sa.String(), nullable=True))

    # movies: product_id index (既存カラムにインデックスがない場合)
    existing_idx = [row[0] for row in conn.execute(
        sa.text("SELECT indexname FROM pg_indexes WHERE tablename='movies' AND indexname='ix_movies_product_id'")
    )]
    if 'ix_movies_product_id' not in existing_idx:
        op.create_index(op.f('ix_movies_product_id'), 'movies', ['product_id'], unique=False)


def downgrade() -> None:
    op.drop_column('movies', 'is_visible')
    op.drop_column('movies', 'affiliate_url_en')
    op.drop_index(op.f('ix_movies_product_id'), table_name='movies')
