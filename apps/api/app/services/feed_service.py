from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.movie_repository import get_all_movies
from app.schemas.feed import FeedResponse
from app.schemas.movie import MovieCard


async def get_feed(db: AsyncSession) -> FeedResponse:
    movies = await get_all_movies(db)

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

    return FeedResponse(items=items, next_cursor=None)
