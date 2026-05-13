import uuid

from sqlalchemy import Date, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class Movie(Base):
    __tablename__ = "movies"

    id: Mapped[str] = mapped_column(primary_key=True, default=lambda: str(uuid.uuid4()))

    # FANZA識別子
    content_id: Mapped[str | None] = mapped_column(String, unique=True, index=True)  # FANZA商品ID
    product_id: Mapped[str | None] = mapped_column(String, index=True)               # 品番（流通用）
    maker_product: Mapped[str | None] = mapped_column(String)                         # メーカー品番

    # 基本情報
    title: Mapped[str] = mapped_column(String, nullable=False)
    slug: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    volume: Mapped[int | None] = mapped_column(Integer)                               # 収録時間（分）

    # 画像・動画URL
    image_url_list: Mapped[str | None] = mapped_column(String)                        # 一覧用（小）
    image_url_large: Mapped[str | None] = mapped_column(String)                       # 詳細用（大）
    sample_movie_url: Mapped[str | None] = mapped_column(String)
    sample_embed_url: Mapped[str | None] = mapped_column(String)                      # 埋め込み用（互換）

    # アフィリエイト
    affiliate_url: Mapped[str] = mapped_column(String, default="")
    affiliate_url_en: Mapped[str | None] = mapped_column(String)                      # 英語向けURL

    # 価格
    price_list: Mapped[dict | None] = mapped_column(JSONB)                            # 全価格体系（JSONB）
    price_min: Mapped[int | None] = mapped_column(Integer)                            # 最安値（ソート用）

    # 日付
    release_date: Mapped[str | None] = mapped_column(Date)                            # 発売日
    delivery_date: Mapped[str | None] = mapped_column(Date)                           # 配信開始日
    rental_start_date: Mapped[str | None] = mapped_column(Date)                       # 貸出開始日
    primary_date: Mapped[str | None] = mapped_column(Date, index=True)                # 表示用日付

    # レビュー
    review_count: Mapped[int] = mapped_column(Integer, default=0)
    review_average: Mapped[float | None] = mapped_column(Numeric(3, 2))

    # 制作者情報（単一値・正規化不要）
    director_name: Mapped[str | None] = mapped_column(String)
    label_name: Mapped[str | None] = mapped_column(String)
    maker_name: Mapped[str | None] = mapped_column(String)

    # シリーFK
    series_id: Mapped[str | None] = mapped_column(
        ForeignKey("series.id", ondelete="SET NULL"), index=True
    )

    # 運用フラグ
    is_visible: Mapped[bool] = mapped_column(default=True)

    # リレーション
    series: Mapped["Series | None"] = relationship("Series", back_populates="movies", lazy="selectin")
    genres: Mapped[list["Genre"]] = relationship(
        secondary="movie_genres", back_populates="movies", lazy="selectin"
    )
    actresses: Mapped[list["Actress"]] = relationship(
        secondary="movie_actresses", back_populates="movies", lazy="selectin"
    )


class MovieGenre(Base):
    __tablename__ = "movie_genres"
    __table_args__ = (UniqueConstraint("movie_id", "genre_id"),)

    movie_id: Mapped[str] = mapped_column(ForeignKey("movies.id", ondelete="CASCADE"), primary_key=True)
    genre_id: Mapped[int] = mapped_column(ForeignKey("genres.id", ondelete="CASCADE"), primary_key=True)


class MovieActress(Base):
    __tablename__ = "movie_actresses"
    __table_args__ = (UniqueConstraint("movie_id", "actress_id"),)

    movie_id: Mapped[str] = mapped_column(ForeignKey("movies.id", ondelete="CASCADE"), primary_key=True)
    actress_id: Mapped[int] = mapped_column(ForeignKey("actresses.id", ondelete="CASCADE"), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, default=0)                         # 出演順（0始まり）
