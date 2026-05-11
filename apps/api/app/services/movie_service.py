from app.schemas.movie import MovieDetail

_MOVIES = [
    MovieDetail(
        id="movie-001",
        title="サンプル作品 001",
        slug="sample-movie-001",
        description="これはサンプル作品 001 の説明です。",
        thumbnail_url="https://placehold.co/720x1280/png",
        sample_embed_url="https://example.com/embed/movie-001",
        actresses=["女優A"],
        genres=["ジャンルA", "ジャンルB"],
        affiliate_url="https://example.com/affiliate/movie-001",
    ),
    MovieDetail(
        id="movie-002",
        title="サンプル作品 002",
        slug="sample-movie-002",
        description="これはサンプル作品 002 の説明です。",
        thumbnail_url="https://placehold.co/720x1280/png",
        sample_embed_url="https://example.com/embed/movie-002",
        actresses=["女優B"],
        genres=["ジャンルC"],
        affiliate_url="https://example.com/affiliate/movie-002",
    ),
]


def get_movie_by_slug(slug: str) -> MovieDetail | None:
    for movie in _MOVIES:
        if movie.slug == slug:
            return movie
    return None