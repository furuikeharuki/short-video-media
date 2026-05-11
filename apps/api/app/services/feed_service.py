from app.mock_data.movies import load_movies
from app.schemas.feed import FeedResponse
from app.schemas.movie import MovieCard


def get_feed() -> FeedResponse:
    movies = load_movies()

    items = [
        MovieCard(
            id=movie.id,
            title=movie.title,
            slug=movie.slug,
            thumbnail_url=movie.thumbnail_url,
            sample_embed_url=movie.sample_embed_url,
            actresses=movie.actresses,
            genres=movie.genres,
        )
        for movie in movies
    ]

    return FeedResponse(items=items, next_cursor=None)