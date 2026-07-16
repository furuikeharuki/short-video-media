"""add dmm_description column to movies

Revision ID: c8e1a2d4f307
Revises: b4c6d8e2f901
Create Date: 2026-07-16 00:00:00.000000+00:00

DMM litevideo ページの ``__NEXT_DATA__`` (videoContent.text) から抽出した
作品説明文を保存するための列を追加する。

背景:
  - サンプル動画 MP4 URL を抽出する際に fetch している litevideo ページの
    HTML には ``<script id="__NEXT_DATA__">`` があり、その JSON に DMM 側の
    作品説明文 (数百字の日本語) が含まれている。
  - これを MP4 解決と同じタイミングで取得して DB に保存し、詳細ページ /
    詳細モーダルに表示する (シンコンテンツ対策 & SSR で crawler に見せる)。
  - FANZA API 由来の既存 `description` とは別ソースなので、別列で保持する。

upgrade  : dmm_description (TEXT, NULL 許容) を追加。
downgrade: 同列を削除。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "c8e1a2d4f307"
down_revision: Union[str, None] = "b4c6d8e2f901"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "movies", sa.Column("dmm_description", sa.Text(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("movies", "dmm_description")
