from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.schemas.movie import MovieDetail
from app.services.movie_service import get_movie_by_slug_service

router = APIRouter()


@router.get("/movies/{slug}", response_model=MovieDetail)
async def read_movie(slug: str, db: AsyncSession = Depends(get_db)) -> MovieDetail:
    movie = await get_movie_by_slug_service(db, slug)
    if movie is None:
        raise HTTPException(status_code=404, detail="Movie not found")
    return movie
