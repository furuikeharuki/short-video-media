from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.search_repository import search_movies
from app.schemas.movie import MovieCard
from app.schemas.search import SearchResponse


async def search(db: AsyncSession, query: str) -> SearchResponse:
    movies = await search_movies(db, query)

    items = [
        MovieCard(
            id=movie.id,
            title=movie.title,
            slug=movie.slug,
            thumbnail_url=movie.thumbnail_url,
            sample_video_url=movie.sample_video_url,
            sample_embed_url=movie.sample_embed_url,
            actresses=[p.name for p in movie.performers],
            genres=[g.name for g in movie.genres],
            affiliate_url=movie.affiliate_url,
        )
        for movie in movies
    ]

    return SearchResponse(items=items, total=len(items))
