from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class Actress(Base):
    __tablename__ = "actresses"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    content_id: Mapped[str | None] = mapped_column(String, unique=True, index=True)  # FANZAのactress_id
    name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    slug: Mapped[str | None] = mapped_column(String, unique=True, index=True)
    thumbnail_url: Mapped[str | None] = mapped_column(String)

    movies: Mapped[list["Movie"]] = relationship(  # noqa: F821
        secondary="movie_actresses", back_populates="actresses", lazy="selectin"
    )
