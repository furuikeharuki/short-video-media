"""drop movies.sample_movie_url

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-05-25 00:00:00.000000+00:00

サンプル動画 MP4 URL の DB キャッシュを廃止する。
MP4 URL は apps/api 内の resolve-mp4 endpoint がユーザー再生時に
in-process httpx で DMM の html5_player ページから都度抽出する
方式に変更したため、movies.sample_movie_url 列は不要になった。

upgrade : 列をドロップ。
downgrade: 列を再追加 (NULL 許容、初期値 NULL)。データは復元されない。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "e5f6a7b8c9d0"
down_revision: Union[str, None] = "d4e5f6a7b8c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_column("movies", "sample_movie_url")


def downgrade() -> None:
    op.add_column(
        "movies",
        sa.Column("sample_movie_url", sa.String(), nullable=True),
    )
