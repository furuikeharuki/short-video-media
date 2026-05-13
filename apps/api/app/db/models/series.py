from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class Series(Base):
    __tablename__ = "series"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    content_id: Mapped[str | None] = mapped_column(String, unique=True, index=True)  # FANZAのseries_id
    name: Mapped[str] = mapped_column(String, nullable=False)
    slug: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)

    movies: Mapped[list["Movie"]] = relationship(  # noqa: F821
        "Movie", back_populates="series", lazy="selectin"
    )
