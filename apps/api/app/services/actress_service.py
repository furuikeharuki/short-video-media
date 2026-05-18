import os
from urllib.parse import quote

from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.actress_repository import (
    aggregate_actress_stats,
    get_actress_by_name,
    get_actress_by_slug,
    get_goods_by_actress_id,
    get_movies_by_actress_id,
)
from app.schemas.actress import ActressDetail, ActressProfile, ActressStats, GoodsCard
from app.schemas.movie import MovieCard, PriceList


def _build_fanza_search_fallback_url(actress_name: str) -> str | None:
    """`dmm_list_url` が DB に保存されていない女優向けのフォールバック URL を作る。

    DMM ActressSearch API の `listURL.digital` が空 (または該当が無い) ケースでも
    「DMM で 〜 の作品を見る」ボタンを出したいので、FANZA キーワード検索ページに
    アフィリエイトリンク経由で飛ばす URL を組み立てる。

    `DMM_LINK_AFFILIATE_ID` が未設定のときはアフィ収益が紐づかないので None を返し、
    呼び出し側は従来通り「URL が無い」扱いにする。
    """
    af_id = os.getenv("DMM_LINK_AFFILIATE_ID") or os.getenv("DMM_AFFILIATE_ID")
    if not af_id or not actress_name:
        return None
    # FANZA 動画 (videoa) の女優名検索ページに飛ばす。
    # アクセス時に DMM 側で年齢確認 → 年齢通過後に検索結果が表示される。
    inner = f"https://www.dmm.co.jp/digital/videoa/-/list/search/=/searchstr={quote(actress_name)}/"
    lurl = quote(inner, safe="")
    return f"https://al.dmm.co.jp/?lurl={lurl}&af_id={af_id}&ch=link_tool&ch_id=link"


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


def _to_goods_card(goods) -> GoodsCard:
    return GoodsCard(
        id=goods.id,
        content_id=goods.content_id,
        title=goods.title,
        slug=goods.slug,
        image_url_list=goods.image_url_list,
        image_url_large=goods.image_url_large,
        affiliate_url=goods.affiliate_url or "",
        price_list=PriceList.model_validate(goods.price_list) if goods.price_list else None,
        price_min=goods.price_min,
        review_count=goods.review_count or 0,
        review_average=float(goods.review_average) if goods.review_average else None,
        maker_name=goods.maker_name,
    )


async def get_actress_detail_service(
    db: AsyncSession,
    *,
    name: str | None = None,
    slug: str | None = None,
    movie_limit: int = 60,
    goods_limit: int = 40,
) -> ActressDetail | None:
    """女優詳細 (プロフィール + 出演作品 + 関連商品 + 集計) を返す。"""
    actress = None
    if slug:
        actress = await get_actress_by_slug(db, slug)
    if actress is None and name:
        actress = await get_actress_by_name(db, name)
    if actress is None:
        return None

    movies = await get_movies_by_actress_id(db, actress.id, limit=movie_limit)
    goods = await get_goods_by_actress_id(db, actress.id, limit=goods_limit)
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
        dmm_list_url=(
            actress.dmm_list_url
            or _build_fanza_search_fallback_url(actress.name)
        ),
    )

    stats = ActressStats(**stats_dict)
    items = [_to_card(m) for m in movies]
    goods_items = [_to_goods_card(g) for g in goods]

    return ActressDetail(
        profile=profile,
        stats=stats,
        movies=items,
        goods=goods_items,
    )
