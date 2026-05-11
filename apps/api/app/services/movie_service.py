from app.mock_data.movies import load_movies
from app.schemas.movie import MovieDetail


def get_movie_by_slug(slug: str) -> MovieDetail | None:
    movies = load_movies()

    for movie in movies:
        if movie.slug == slug:
            return movie

    return None