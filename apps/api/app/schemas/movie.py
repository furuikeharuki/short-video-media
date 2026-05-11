from pydantic import BaseModel


class MovieCard(BaseModel):
    id: str
    title: str
    slug: str
    thumbnail_url: str
    sample_embed_url: str
    actresses: list[str]
    genres: list[str]