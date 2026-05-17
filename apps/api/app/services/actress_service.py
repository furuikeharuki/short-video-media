from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.actress_repository import (
    aggregate_actress_stats,
    get_actress_by_name,
    get_actress_by_slug,
    get_movies_by_actress_id,
)
from app.schemas.actress import ActressDetail, ActressProfile, ActressStats
from app.schemas.movie import MovieCard, PriceList


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


async def get_actress_detail_service(
    db: AsyncSession,
    *,
    name: str | None = None,
    slug: str | None = None,
    movie_limit: int = 60,
) -> ActressDetail | None:
    """女優詳細 (プロフィール + 出演作品 + 集計) を返す。"""
    actress = None
    if slug:
        actress = await get_actress_by_slug(db, slug)
    if actress is None and name:
        actress = await get_actress_by_name(db, name)
    if actress is None:
        return None

    movies = await get_movies_by_actress_id(db, actress.id, limit=movie_limit)
    stats_dict = aggregate_actress_stats(movies)

    profile = ActressProfile(
        id=actress.id,
        name=actress.name,
        slug=actress.slug,
        ruby=actress.ruby,
        thumbnail_url=actress.thumbnail_url,
        image_url_small=actress.image_url_small,
        image_url_large=actress.image_url_large,
        bust=actress.bust,
        cup=actress.cup,
        waist=actress.waist,
        hip=actress.hip,
        height=actress.height,
        birthday=str(actress.birthday) if actress.birthday else None,
        blood_type=actress.blood_type,
        hobby=actress.hobby,
        prefectures=actress.prefectures,
        dmm_list_url=actress.dmm_list_url,
    )

    stats = ActressStats(**stats_dict)
    items = [_to_card(m) for m in movies]

    return ActressDetail(profile=profile, stats=stats, movies=items)
