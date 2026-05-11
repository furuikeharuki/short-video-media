from app.schemas.feed import FeedResponse
from app.schemas.movie import MovieCard


def get_feed() -> FeedResponse:
    items = [
        MovieCard(
            id="movie-001",
            title="サンプル作品 001",
            slug="sample-movie-001",
            thumbnail_url="https://placehold.co/720x1280/png",
            sample_embed_url="https://example.com/embed/movie-001",
            actresses=["女優A"],
            genres=["ジャンルA", "ジャンルB"],
        ),
        MovieCard(
            id="movie-002",
            title="サンプル作品 002",
            slug="sample-movie-002",
            thumbnail_url="https://placehold.co/720x1280/png",
            sample_embed_url="https://example.com/embed/movie-002",
            actresses=["女優B"],
            genres=["ジャンルC"],
        ),
    ]

    return FeedResponse(items=items, next_cursor=None)