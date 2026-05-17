"""add goods + actress_goods tables

Revision ID: b2c3d4e5f6a7
Revises: 6c7d92a4f1b8
Create Date: 2026-05-18 02:00:00.000000+00:00

女優グッズ (FANZA mono/goods フロア) を Movie とは別テーブルで保持する。

設計メモ:
  - Movie テーブルは「動画」専用。フィード/ランキング/検索は Movie だけが対象
  - Goods は女優詳細ページの「関連商品」セクションでだけ参照する
  - ActressGoods は女優との多対多 (DMM API では 1 商品 = 1〜複数女優)
  - sample_movie_url, sample_embed_url, series_id, director_name など動画固有
    のカラムは Goods から除外
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, None] = "6c7d92a4f1b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "goods",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("content_id", sa.String(), nullable=True),
        sa.Column("product_id", sa.String(), nullable=True),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("slug", sa.String(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True, server_default=""),
        sa.Column("image_url_list", sa.String(), nullable=True),
        sa.Column("image_url_large", sa.String(), nullable=True),
        sa.Column("affiliate_url", sa.String(), nullable=True, server_default=""),
        sa.Column("price_list", sa.dialects.postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("price_min", sa.Integer(), nullable=True),
        sa.Column("release_date", sa.Date(), nullable=True),
        sa.Column("primary_date", sa.Date(), nullable=True),
        sa.Column("review_count", sa.Integer(), nullable=True, server_default="0"),
        sa.Column("review_average", sa.Numeric(precision=3, scale=2), nullable=True),
        sa.Column("maker_name", sa.String(), nullable=True),
        sa.Column("label_name", sa.String(), nullable=True),
        sa.Column("is_visible", sa.Boolean(), nullable=True, server_default=sa.text("true")),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("content_id"),
        sa.UniqueConstraint("slug"),
    )
    op.create_index("ix_goods_content_id", "goods", ["content_id"], unique=False)
    op.create_index("ix_goods_product_id", "goods", ["product_id"], unique=False)
    op.create_index("ix_goods_slug", "goods", ["slug"], unique=False)
    op.create_index("ix_goods_primary_date", "goods", ["primary_date"], unique=False)
    op.create_index(
        "ix_goods_visible_primary_date",
        "goods",
        ["is_visible", "primary_date"],
        unique=False,
    )

    op.create_table(
        "actress_goods",
        sa.Column("goods_id", sa.String(), nullable=False),
        sa.Column("actress_id", sa.Integer(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=True, server_default="0"),
        sa.ForeignKeyConstraint(["actress_id"], ["actresses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["goods_id"], ["goods.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("goods_id", "actress_id"),
        sa.UniqueConstraint("goods_id", "actress_id"),
    )


def downgrade() -> None:
    op.drop_table("actress_goods")
    op.drop_index("ix_goods_visible_primary_date", table_name="goods")
    op.drop_index("ix_goods_primary_date", table_name="goods")
    op.drop_index("ix_goods_slug", table_name="goods")
    op.drop_index("ix_goods_product_id", table_name="goods")
    op.drop_index("ix_goods_content_id", table_name="goods")
    op.drop_table("goods")
