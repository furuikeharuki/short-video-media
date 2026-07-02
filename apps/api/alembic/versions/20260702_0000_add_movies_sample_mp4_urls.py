"""add sample mp4 url cache columns to movies

Revision ID: a7d3f9c1e204
Revises: 5e1c8b2a90f4
Create Date: 2026-07-02 00:00:00.000000+00:00

サンプル動画 MP4 直リンクを DB にキャッシュするための列を追加する。

背景:
  - 以前 (e5f6a7b8c9d0) は「DMM トークン期限切れで再生不可になる」ため
    MP4 URL を DB に保持せず、再生のたびに resolver_client (in-process httpx)
    で都度抽出していた。
  - しかし毎回抽出は高画質再生までのレイテンシが大きい (cold で数秒)。
  - そこで「月次ジョブ (sync_video_urls) で事前抽出して DB に保存 → 再生時は
    DB 値を即返す。DB に無い / 再生できない (force=true) ときだけ都度抽出し、
    その結果で DB を更新する」という DB キャッシュ + フォールバック方式に戻す。
  - DMM トークンは 32 日以上有効なので、月次で貼り直せば期限切れは実質起きない。

列:
  - sample_mp4_url         : 互換 / 最良 (高画質寄り) の 1 本
  - sample_low_mp4_url     : 低画質ファースト戦略用の軽量候補
  - sample_high_mp4_url    : 高画質候補
  - sample_mp4_resolved_at : 最後に抽出・保存した時刻 (naive UTC)

upgrade  : 4 列を追加 (すべて NULL 許容)。
downgrade: 4 列を削除。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "a7d3f9c1e204"
down_revision: Union[str, None] = "5e1c8b2a90f4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("movies", sa.Column("sample_mp4_url", sa.String(), nullable=True))
    op.add_column(
        "movies", sa.Column("sample_low_mp4_url", sa.String(), nullable=True)
    )
    op.add_column(
        "movies", sa.Column("sample_high_mp4_url", sa.String(), nullable=True)
    )
    op.add_column(
        "movies",
        sa.Column("sample_mp4_resolved_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("movies", "sample_mp4_resolved_at")
    op.drop_column("movies", "sample_high_mp4_url")
    op.drop_column("movies", "sample_low_mp4_url")
    op.drop_column("movies", "sample_mp4_url")
