import uuid

from sqlalchemy import ForeignKey, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class Movie(Base):
    __tablename__ = "movies"

    id: Mapped[str] = mapped_column(primary_key=True, default=lambda: str(uuid.uuid4()))
    fanza_id: Mapped[str | None] = mapped_column(unique=True, index=True)
    title: Mapped[str]
    slug: Mapped[str] = mapped_column(unique=True, index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    thumbnail_url: Mapped[str] = mapped_column(default="")
    sample_video_url: Mapped[str | None] = mapped_column(default=None)
    sample_embed_url: Mapped[str] = mapped_column(default="")
    affiliate_url: Mapped[str] = mapped_column(default="")

    genres: Mapped[list["Genre"]] = relationship(
        secondary="movie_genres", back_populates="movies", lazy="selectin"
    )
    performers: Mapped[list["Performer"]] = relationship(
        secondary="movie_performers", back_populates="movies", lazy="selectin"
    )


class MovieGenre(Base):
    __tablename__ = "movie_genres"
    __table_args__ = (UniqueConstraint("movie_id", "genre_id"),)

    movie_id: Mapped[str] = mapped_column(ForeignKey("movies.id", ondelete="CASCADE"), primary_key=True)
    genre_id: Mapped[int] = mapped_column(ForeignKey("genres.id", ondelete="CASCADE"), primary_key=True)


class MoviePerformer(Base):
    __tablename__ = "movie_performers"
    __table_args__ = (UniqueConstraint("movie_id", "performer_id"),)

    movie_id: Mapped[str] = mapped_column(ForeignKey("movies.id", ondelete="CASCADE"), primary_key=True)
    performer_id: Mapped[int] = mapped_column(ForeignKey("performers.id", ondelete="CASCADE"), primary_key=True)
