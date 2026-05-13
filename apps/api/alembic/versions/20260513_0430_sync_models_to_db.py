"""sync_models_to_db

Revision ID: sync_models_to_db
Revises: add_missing_columns
Create Date: 2026-05-13 04:30:00.000000+00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'sync_models_to_db'
down_revision: Union[str, None] = 'add_missing_columns'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- actresses: カラム追加 ---
    op.add_column('actresses', sa.Column('fanza_id', sa.String(), nullable=True))
    op.add_column('actresses', sa.Column('slug', sa.String(), nullable=True))
    op.add_column('actresses', sa.Column('thumbnail_url', sa.String(), nullable=True))
    op.drop_index('ix_actresses_name', table_name='actresses')
    op.create_index('ix_actresses_name', 'actresses', ['name'], unique=False)
    op.create_index('ix_actresses_fanza_id', 'actresses', ['fanza_id'], unique=True)
    op.create_index('ix_actresses_slug', 'actresses', ['slug'], unique=True)

    # --- movie_actresses: position追加、unique constraint ---
    op.add_column('movie_actresses', sa.Column('position', sa.Integer(), server_default='0', nullable=False))
    op.create_unique_constraint('uq_movie_actresses', 'movie_actresses', ['movie_id', 'actress_id'])

    # --- movie_genres: unique constraint ---
    op.create_unique_constraint('uq_movie_genres', 'movie_genres', ['movie_id', 'genre_id'])

    # --- movies: volume型修正 VARCHAR -> Integer ---
    op.alter_column('movies', 'volume',
                    existing_type=sa.VARCHAR(),
                    type_=sa.Integer(),
                    existing_nullable=True,
                    postgresql_using='volume::integer')

    # --- movies: series_id型修正 Integer -> String ---
    op.alter_column('movies', 'series_id',
                    existing_type=sa.INTEGER(),
                    type_=sa.String(),
                    existing_nullable=True,
                    postgresql_using='series_id::text')

    # --- movies: インデックス追加 ---
    op.create_index('ix_movies_primary_date', 'movies', ['primary_date'], unique=False)
    op.create_index('ix_movies_series_id', 'movies', ['series_id'], unique=False)

    # --- movies: 不要カラム削除 ---
    op.drop_column('movies', '_sample_video_url_old')

    # --- series: id型修正 Integer -> String ---
    # seriesはまだデータなしなのでテーブルを再作成
    op.drop_index('ix_series_name', table_name='series')
    op.drop_table('series')
    op.create_table(
        'series',
        sa.Column('id', sa.String(), nullable=False),
        sa.Column('fanza_id', sa.String(), nullable=True),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('slug', sa.String(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_series_fanza_id', 'series', ['fanza_id'], unique=True)
    op.create_index('ix_series_slug', 'series', ['slug'], unique=True)


def downgrade() -> None:
    pass
