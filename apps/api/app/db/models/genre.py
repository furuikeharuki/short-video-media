from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class Genre(Base):
    __tablename__ = "genres"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)

    movies: Mapped[list["Movie"]] = relationship(  # noqa: F821
        secondary="movie_genres", back_populates="genres", lazy="selectin"
    )
