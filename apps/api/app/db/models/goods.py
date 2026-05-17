"""女優グッズ (FANZA mono/goods フロア) のデータモデル。

Movie とは独立したテーブルとして扱う。フィード/ランキングは動画 (Movie) だけが
対象であり、グッズは女優詳細ページの「関連商品」セクションでのみ参照される。

DB 上は ActressGoods 中間テーブルで女優との多対多関係を持つが、現状の DMM API
仕様では 1 商品 = 1 (代表) 女優として保存している (関連する女優が複数いれば全員紐付)。
"""
import uuid

from sqlalchemy import Date, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class Goods(Base):
    __tablename__ = "goods"
    __table_args__ = (
        Index("ix_goods_visible_primary_date", "is_visible", "primary_date"),
    )

    id: Mapped[str] = mapped_column(primary_key=True, default=lambda: str(uuid.uuid4()))

    # FANZA 識別子
    content_id: Mapped[str | None] = mapped_column(String, unique=True, index=True)
    product_id: Mapped[str | None] = mapped_column(String, index=True)

    # 基本情報
    title: Mapped[str] = mapped_column(String, nullable=False)
    slug: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")

    # 画像
    image_url_list: Mapped[str | None] = mapped_column(String)
    image_url_large: Mapped[str | None] = mapped_column(String)

    # アフィリエイト
    affiliate_url: Mapped[str] = mapped_column(String, default="")

    # 価格
    price_list: Mapped[dict | None] = mapped_column(JSONB)
    price_min: Mapped[int | None] = mapped_column(Integer)

    # 日付
    release_date: Mapped[str | None] = mapped_column(Date)
    primary_date: Mapped[str | None] = mapped_column(Date, index=True)

    # レビュー
    review_count: Mapped[int] = mapped_column(Integer, default=0)
    review_average: Mapped[float | None] = mapped_column(Numeric(3, 2))

    # 制作者情報
    maker_name: Mapped[str | None] = mapped_column(String)
    label_name: Mapped[str | None] = mapped_column(String)

    # 運用フラグ
    is_visible: Mapped[bool] = mapped_column(default=True)

    actresses: Mapped[list["Actress"]] = relationship(  # noqa: F821
        secondary="actress_goods", back_populates="goods", lazy="selectin"
    )


class ActressGoods(Base):
    __tablename__ = "actress_goods"
    __table_args__ = (UniqueConstraint("goods_id", "actress_id"),)

    goods_id: Mapped[str] = mapped_column(
        ForeignKey("goods.id", ondelete="CASCADE"), primary_key=True
    )
    actress_id: Mapped[int] = mapped_column(
        ForeignKey("actresses.id", ondelete="CASCADE"), primary_key=True
    )
    position: Mapped[int] = mapped_column(Integer, default=0)
