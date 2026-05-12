from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.movie_repository import get_movie_by_slug
from app.schemas.movie import MovieDetail


async def get_movie_by_slug_service(db: AsyncSession, slug: str) -> MovieDetail | None:
    movie = await get_movie_by_slug(db, slug)
    if movie is None:
        return None
    return MovieDetail(
        id=movie.id,
        title=movie.title,
        slug=movie.slug,
        description=movie.description,
        thumbnail_url=movie.thumbnail_url,
        sample_embed_url=movie.sample_embed_url,
        actresses=[p.name for p in movie.performers],
        genres=[g.name for g in movie.genres],
        affiliate_url=movie.affiliate_url,
    )
