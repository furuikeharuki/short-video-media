import uuid

from sqlalchemy import Date, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class Movie(Base):
    __tablename__ = "movies"
    # フィード/ランキング用の複合 index。マイグレーション 6c7d92a4f1b8 と一致させること。
    __table_args__ = (
        Index("ix_movies_visible_primary_date", "is_visible", "primary_date"),
        Index("ix_movies_visible_review_count", "is_visible", "review_count"),
    )

    id: Mapped[str] = mapped_column(primary_key=True, default=lambda: str(uuid.uuid4()))

    # FANZA識別子
    content_id: Mapped[str | None] = mapped_column(String, unique=True, index=True)
    product_id: Mapped[str | None] = mapped_column(String, index=True)
    maker_product: Mapped[str | None] = mapped_column(String)

    # 基本情報
    title: Mapped[str] = mapped_column(String, nullable=False)
    slug: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    volume: Mapped[int | None] = mapped_column(Integer)

    # 画像・動画URL
    image_url_list: Mapped[str | None] = mapped_column(String)
    image_url_large: Mapped[str | None] = mapped_column(String)
    # sample_movie_url (MP4 直リンク) は DB に保持しない。
    # apps/api 側の resolve-mp4 endpoint がユーザー再生時に in-process httpx で
    # 都度抽出する (DB キャッシュ無し)。トークン寿命管理から解放されるため
    # 期限切れ問題が原理的に発生しない。
    sample_embed_url: Mapped[str | None] = mapped_column(String)

    # アフィリエイト
    affiliate_url: Mapped[str] = mapped_column(String, default="")
    affiliate_url_en: Mapped[str | None] = mapped_column(String)

    # 価格
    price_list: Mapped[dict | None] = mapped_column(JSONB)
    price_min: Mapped[int | None] = mapped_column(Integer)

    # 日付
    release_date: Mapped[str | None] = mapped_column(Date)
    delivery_date: Mapped[str | None] = mapped_column(Date)
    rental_start_date: Mapped[str | None] = mapped_column(Date)
    primary_date: Mapped[str | None] = mapped_column(Date, index=True)

    # レビュー
    review_count: Mapped[int] = mapped_column(Integer, default=0)
    review_average: Mapped[float | None] = mapped_column(Numeric(3, 2))

    # 制作者情報
    director_name: Mapped[str | None] = mapped_column(String)
    label_name: Mapped[str | None] = mapped_column(String)
    maker_name: Mapped[str | None] = mapped_column(String)

    # シリーズFK
    series_id: Mapped[str | None] = mapped_column(
        ForeignKey("series.id", ondelete="SET NULL"), index=True
    )

    # 運用フラグ
    is_visible: Mapped[bool] = mapped_column(default=True)

    # リレーション
    # joined: 1本のJOINクエリで取得。フィードのような一覧取得で効率的。
    # selectin は件数が多い多対多（genres, actresses）に対して
    # IN句で一括取得するため、joinedより適している場合もあるが、
    # フィード用途では joined に統一してクエリ本数を最小化する。
    series: Mapped["Series | None"] = relationship(
        "Series", back_populates="movies", lazy="joined"
    )
    genres: Mapped[list["Genre"]] = relationship(
        secondary="movie_genres", back_populates="movies", lazy="selectin"
    )
    actresses: Mapped[list["Actress"]] = relationship(
        secondary="movie_actresses", back_populates="movies", lazy="selectin"
    )


class MovieGenre(Base):
    __tablename__ = "movie_genres"
    # PK (movie_id, genre_id) は「ある作品のジャンルを引く」用途には最適だが、
    # 逆方向 (「あるジャンルを持つ作品を引く」) の leading-column index が無いと
    # Seq Scan に倒れるため、(genre_id, movie_id) の逆方向 index を追加する。
    # マイグレーション 5e1c8b2a90f4 と一致させること。
    __table_args__ = (
        UniqueConstraint("movie_id", "genre_id"),
        Index("ix_movie_genres_genre_id", "genre_id", "movie_id"),
    )

    movie_id: Mapped[str] = mapped_column(ForeignKey("movies.id", ondelete="CASCADE"), primary_key=True)
    genre_id: Mapped[int] = mapped_column(ForeignKey("genres.id", ondelete="CASCADE"), primary_key=True)


class MovieActress(Base):
    __tablename__ = "movie_actresses"
    # PK (movie_id, actress_id) と同じ理由で (actress_id, movie_id) の
    # 逆方向 index を追加する。マイグレーション 5e1c8b2a90f4 と一致させること。
    __table_args__ = (
        UniqueConstraint("movie_id", "actress_id"),
        Index("ix_movie_actresses_actress_id", "actress_id", "movie_id"),
    )

    movie_id: Mapped[str] = mapped_column(ForeignKey("movies.id", ondelete="CASCADE"), primary_key=True)
    actress_id: Mapped[int] = mapped_column(ForeignKey("actresses.id", ondelete="CASCADE"), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
