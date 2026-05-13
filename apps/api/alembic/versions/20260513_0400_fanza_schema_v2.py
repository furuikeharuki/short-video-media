"""fanza_schema_v2

Revision ID: fanza_schema_v2
Revises: add_sample_video_url
Create Date: 2026-05-13 04:00:00.000000+00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'fanza_schema_v2'
down_revision: Union[str, None] = 'add_sample_video_url'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- series テーブル追加 ---
    op.create_table(
        'series',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_series_name'), 'series', ['name'], unique=True)

    # --- actresses テーブル追加 ---
    op.create_table(
        'actresses',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_actresses_name'), 'actresses', ['name'], unique=True)

    # --- movie_actresses 中間テーブル追加 ---
    op.create_table(
        'movie_actresses',
        sa.Column('movie_id', sa.String(), nullable=False),
        sa.Column('actress_id', sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(['movie_id'], ['movies.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['actress_id'], ['actresses.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('movie_id', 'actress_id'),
        sa.UniqueConstraint('movie_id', 'actress_id'),
    )

    # --- movies テーブル: 旧カラム削除 ---
    op.drop_index('ix_movies_fanza_id', table_name='movies')
    op.drop_column('movies', 'fanza_id')
    op.drop_column('movies', 'thumbnail_url')
    op.drop_column('movies', 'sample_embed_url')  # sample_video_urlは前マイグで追加済み

    # --- movies テーブル: 新カラム追加 ---
    op.add_column('movies', sa.Column('content_id', sa.String(), nullable=True))
    op.add_column('movies', sa.Column('product_id', sa.String(), nullable=True))
    op.add_column('movies', sa.Column('maker_product', sa.String(), nullable=True))
    op.add_column('movies', sa.Column('volume', sa.String(), nullable=True))
    op.add_column('movies', sa.Column('image_url_list', sa.String(), nullable=True))
    op.add_column('movies', sa.Column('image_url_large', sa.String(), nullable=True))
    op.add_column('movies', sa.Column('sample_movie_url', sa.String(), nullable=True))
    op.add_column('movies', sa.Column('sample_embed_url', sa.String(), nullable=True))
    op.add_column('movies', sa.Column('price_list', postgresql.JSONB(), nullable=True))
    op.add_column('movies', sa.Column('price_min', sa.Integer(), nullable=True))
    op.add_column('movies', sa.Column('release_date', sa.Date(), nullable=True))
    op.add_column('movies', sa.Column('delivery_date', sa.Date(), nullable=True))
    op.add_column('movies', sa.Column('rental_start_date', sa.Date(), nullable=True))
    op.add_column('movies', sa.Column('primary_date', sa.Date(), nullable=True))
    op.add_column('movies', sa.Column('review_count', sa.Integer(), server_default='0', nullable=False))
    op.add_column('movies', sa.Column('review_average', sa.Numeric(precision=3, scale=2), nullable=True))
    op.add_column('movies', sa.Column('director_name', sa.String(), nullable=True))
    op.add_column('movies', sa.Column('label_name', sa.String(), nullable=True))
    op.add_column('movies', sa.Column('maker_name', sa.String(), nullable=True))
    op.add_column('movies', sa.Column('affiliate_url_en', sa.String(), nullable=True))
    op.add_column('movies', sa.Column('series_id', sa.Integer(), nullable=True))
    op.create_foreign_key(
        'fk_movies_series_id', 'movies', 'series', ['series_id'], ['id'], ondelete='SET NULL'
    )
    op.create_index(op.f('ix_movies_content_id'), 'movies', ['content_id'], unique=True)

    # --- movie_performers / performers 削除 ---
    op.drop_table('movie_performers')
    op.drop_index('ix_performers_name', table_name='performers')
    op.drop_table('performers')

    # --- sample_video_url カラム名変更（前マイグで追加されている） ---
    op.alter_column('movies', 'sample_video_url', new_column_name='_sample_video_url_old', nullable=True)


def downgrade() -> None:
    # 簡易ロールバック: 本番運用では使用しない前提
    op.drop_table('movie_actresses')
    op.drop_index(op.f('ix_actresses_name'), table_name='actresses')
    op.drop_table('actresses')
    op.drop_index(op.f('ix_series_name'), table_name='series')
    op.drop_table('series')
