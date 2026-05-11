from app.mock_data.movies import MOVIES
from app.schemas.movie import MovieDetail


def get_movie_by_slug(slug: str) -> MovieDetail | None:
    for movie in MOVIES:
        if movie.slug == slug:
            return movie
    return None