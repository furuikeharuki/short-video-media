import json
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cache import get_redis
from app.repositories.movie_repository import get_movie_by_slug
from app.schemas.movie import MovieDetail, PriceList

MOVIE_DETAIL_TTL = 1800  # 30分
MOVIE_DETAIL_KEY_PREFIX = "movie:detail:"


async def get_movie_by_slug_service(db: AsyncSession, slug: str) -> MovieDetail | None:
    redis = get_redis()
    key = f"{MOVIE_DETAIL_KEY_PREFIX}{slug}"

    # Redisキャッシュ確認
    if redis is not None:
        cached = await redis.get(key)
        if cached:
            return MovieDetail.model_validate(json.loads(cached))

    # DBから取得
    movie = await get_movie_by_slug(db, slug)
    if movie is None:
        return None

    price_list = None
    if movie.price_list:
        price_list = PriceList.model_validate(movie.price_list)

    detail = MovieDetail(
        id=str(movie.id),
        content_id=movie.content_id,
        product_id=movie.product_id,
        maker_product=movie.maker_product,
        title=movie.title,
        slug=movie.slug,
        description=movie.description or "",
        volume=movie.volume,
        image_url_list=movie.image_url_list,
        image_url_large=movie.image_url_large,
        sample_movie_url=movie.sample_movie_url,
        sample_embed_url=movie.sample_embed_url,
        affiliate_url=movie.affiliate_url,
        price_list=price_list,
        price_min=movie.price_min,
        release_date=str(movie.release_date) if movie.release_date else None,
        delivery_date=str(movie.delivery_date) if movie.delivery_date else None,
        rental_start_date=str(movie.rental_start_date) if movie.rental_start_date else None,
        primary_date=str(movie.primary_date) if movie.primary_date else None,
        review_count=movie.review_count or 0,
        review_average=float(movie.review_average) if movie.review_average else None,
        director_name=movie.director_name,
        label_name=movie.label_name,
        maker_name=movie.maker_name,
        actresses=[a.name for a in movie.actresses],
        genres=[g.name for g in movie.genres],
        series_name=movie.series.name if movie.series else None,
    )

    # Redisに保存
    if redis is not None:
        await redis.set(key, json.dumps(detail.model_dump()), ex=MOVIE_DETAIL_TTL)

    return detail