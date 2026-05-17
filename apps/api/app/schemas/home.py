from pydantic import BaseModel

from app.schemas.movie import MovieCard


class HomeSection(BaseModel):
    key: str
    title: str
    subtitle: str | None = None
    genre: str | None = None
    items: list[MovieCard]


class HomeResponse(BaseModel):
    sections: list[HomeSection]
