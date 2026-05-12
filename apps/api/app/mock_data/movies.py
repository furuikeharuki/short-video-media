import json
from pathlib import Path

from app.schemas.movie import MovieDetail

_MOCK_DATA_PATH = Path(__file__).with_name("movies.json")


def load_movies() -> list[MovieDetail]:
    with _MOCK_DATA_PATH.open("r", encoding="utf-8") as f:
        raw_movies = json.load(f)

    return [MovieDetail(**movie) for movie in raw_movies]