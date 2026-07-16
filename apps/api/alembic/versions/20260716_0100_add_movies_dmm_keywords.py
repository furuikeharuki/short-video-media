"""add dmm_keywords column to movies

Revision ID: d1f3b5a7c920
Revises: c8e1a2d4f307
Create Date: 2026-07-16 01:00:00.000000+00:00

dmm_description (FANZA 公式説明文) から janome 形態素解析で抽出した特徴語
(名詞) の配列を保存するための列を追加する。

背景:
  - 詳細ページ / モーダルの「この作品のキーワード」チップに使う。
  - 薄い重複コンテンツ対策として、作品ごとに異なる語彙を SSR HTML に出す。
  - dmm_description の保存と同じタイミング (movie_video_url_service) で抽出・保存し、
    未抽出の既存レコードは GET /api/v1/movies/{slug} の write-on-read で自己補完する。
  - LLM や正規表現による文中パターン抽出は使わない (ルールベースのみ)。

upgrade  : dmm_keywords (JSONB, NULL 許容) を追加。
downgrade: 同列を削除。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "d1f3b5a7c920"
down_revision: Union[str, None] = "c8e1a2d4f307"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "movies", sa.Column("dmm_keywords", postgresql.JSONB(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("movies", "dmm_keywords")
