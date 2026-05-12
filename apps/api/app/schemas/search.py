from pydantic import BaseModel
from app.schemas.movie import MovieCard


class SearchResponse(BaseModel):
    items: list[MovieCard]
    total: int
