from sqlalchemy import Date, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class Actress(Base):
    __tablename__ = "actresses"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    content_id: Mapped[str | None] = mapped_column(String, unique=True, index=True)  # FANZAのactress_id
    name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    slug: Mapped[str | None] = mapped_column(String, unique=True, index=True)
    thumbnail_url: Mapped[str | None] = mapped_column(String)

    # DMM 女優検索 API より取得するプロフィール (すべて nullable)
    ruby:             Mapped[str | None]  = mapped_column(String)  # 女優名読み仮名
    bust:             Mapped[int | None]  = mapped_column(Integer)  # cm
    cup:              Mapped[str | None]  = mapped_column(String)   # A〜Z
    waist:            Mapped[int | None]  = mapped_column(Integer)  # cm
    hip:              Mapped[int | None]  = mapped_column(Integer)  # cm
    height:           Mapped[int | None]  = mapped_column(Integer)  # cm
    birthday:         Mapped[str | None]  = mapped_column(Date)
    blood_type:       Mapped[str | None]  = mapped_column(String)
    hobby:            Mapped[str | None]  = mapped_column(String)
    prefectures:      Mapped[str | None]  = mapped_column(String)
    image_url_small:  Mapped[str | None]  = mapped_column(String)
    image_url_large:  Mapped[str | None]  = mapped_column(String)
    dmm_list_url:     Mapped[str | None]  = mapped_column(String)   # FANZA動画リストページのアフィリエイトURL

    movies: Mapped[list["Movie"]] = relationship(  # noqa: F821
        secondary="movie_actresses", back_populates="actresses", lazy="selectin"
    )
