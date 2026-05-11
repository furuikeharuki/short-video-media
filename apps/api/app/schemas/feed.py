from pydantic import BaseModel

from app.schemas.movie import MovieCard


class FeedResponse(BaseModel):
    items: list[MovieCard]
    next_cursor: str | None = None