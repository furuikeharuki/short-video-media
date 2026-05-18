from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.search_repository import (
    search_movies,
    search_movies_by_exact_field,
)
from app.schemas.movie import MovieCard, PriceList
from app.schemas.search import SearchResponse


def _to_card(movie) -> MovieCard:
    return MovieCard(
        id=movie.id,
        content_id=movie.content_id,
        title=movie.title,
        slug=movie.slug,
        image_url_list=movie.image_url_list,
        image_url_large=movie.image_url_large,
        sample_movie_url=movie.sample_movie_url,
        affiliate_url=movie.affiliate_url or "",
        price_list=PriceList.model_validate(movie.price_list) if movie.price_list else None,
        price_min=movie.price_min,
        review_count=movie.review_count or 0,
        review_average=float(movie.review_average) if movie.review_average else None,
        actresses=[a.name for a in movie.actresses],
        genres=[g.name for g in movie.genres],
        series_name=movie.series.name if movie.series else None,
    )


def _build_response(
    movies: list, total: int, offset: int, limit: int
) -> SearchResponse:
    """共通: items / total / next_cursor を組み立てる。"""
    items = [_to_card(m) for m in movies]
    next_offset = offset + len(items)
    has_more = next_offset < total
    return SearchResponse(
        items=items,
        total=total,
        next_cursor=str(next_offset) if has_more else None,
    )


async def search(
    db: AsyncSession,
    query: str,
    *,
    limit: int = 20,
    offset: int = 0,
) -> SearchResponse:
    movies, total = await search_movies(db, query, limit=limit, offset=offset)
    return _build_response(movies, total, offset, limit)


async def search_by_exact_field(
    db: AsyncSession,
    *,
    director: str | None = None,
    maker: str | None = None,
    label: str | None = None,
    series: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> SearchResponse:
    movies, total = await search_movies_by_exact_field(
        db,
        director=director,
        maker=maker,
        label=label,
        series=series,
        limit=limit,
        offset=offset,
    )
    return _build_response(movies, total, offset, limit)
