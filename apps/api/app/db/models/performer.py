from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class Performer(Base):
    __tablename__ = "performers"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(unique=True, index=True)

    movies: Mapped[list["Movie"]] = relationship(  # noqa: F821
        secondary="movie_performers", back_populates="performers", lazy="selectin"
    )
