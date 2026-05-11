from fastapi import APIRouter, HTTPException

from app.schemas.movie import MovieDetail
from app.services.movie_service import get_movie_by_slug

router = APIRouter()


@router.get("/movies/{slug}", response_model=MovieDetail)
def read_movie(slug: str) -> MovieDetail:
    movie = get_movie_by_slug(slug)

    if movie is None:
        raise HTTPException(status_code=404, detail="Movie not found")

    return movie