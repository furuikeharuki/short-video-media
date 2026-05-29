"""ランキング集計サービス。

イベントテーブル (event_type='view') を集計してランキングを作る。
データが不足しているときは review_count / review_average ベースの
代替ランキングにフォールバックする。
"""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.actress_repository import get_actresses_by_ids_ordered
from app.repositories.event_repository import (
    aggregate_affiliate_click_ranking_by_actress_all_time,
    aggregate_search_query_ranking,
    aggregate_view_ranking,
    aggregate_view_ranking_all_time,
)
from app.repositories.goods_repository import get_popular_goods
from app.repositories.interaction_event_repository import (
    aggregate_watch_count_ranking_all_time,
)
from app.repositories.movie_repository import (
    get_fallback_ranking_movies,
    get_movies_by_slugs_ordered,
)
from app.schemas.actress import ActressCard, GoodsCard
from app.schemas.movie import MovieCard
from app.services.feed_service import _to_card


VALID_PERIODS = ("daily", "weekly", "monthly")

# イベントデータ不足時のフォールバックに使う primary_date 窓。
# 期間ごとに窓を変えることで daily/weekly/monthly を違う並びにし、
# 「ランキングがすべて同じ並びになる」状態を避ける。
_FALLBACK_WINDOW_DAYS = {
    "daily": 7,
    "weekly": 30,
    "monthly": 90,
}


async def get_ranking(
    db: AsyncSession,
    *,
    period: str,
    limit: int = 20,
    offset: int = 0,
) -> list[MovieCard]:
    """期間ランキング。offset/limit は SQL レベルで適用されるため、
    データ量がどれだけ増えても 1 ページあたりの計算量は limit 件に収まる。
    """
    if period not in VALID_PERIODS:
        raise ValueError(f"period must be one of {VALID_PERIODS}")

    cards: list[MovieCard] = []
    seen_ids: set[str] = set()

    ranked = await aggregate_view_ranking(
        db, period=period, limit=limit, offset=offset
    )
    slugs = [s for s, _ in ranked if s]
    if slugs:
        movies = await get_movies_by_slugs_ordered(db, slugs)
        for m in movies:
            if m.id in seen_ids:
                continue
            cards.append(_to_card(m))
            seen_ids.add(m.id)

    if len(cards) >= limit:
        return cards[:limit]

    # 期間内 view イベントだけでは limit に満たないときは、期間ごとに
    # 異なる窓幅 (_FALLBACK_WINDOW_DAYS) のフォールバックで穴埋めする。
    # こうすると view イベントが少なくて daily/weekly/monthly の上位が
    # 同じになるケースでも、フォールバック側の窓 (7/30/90日) の差で
    # 自然に並びが分かれる。
    #
    # フォールバック側に渡す offset:
    #   - イベント由来で 1 件でも取れている場合は 0 から取り直し、
    #     重複は seen_ids で除外する (ページ送り中の二重表示を防ぐ)。
    #   - イベント由来がゼロのときは元の offset を渡してフォールバック
    #     単独のページ送りに切り替わる (従来挙動と同じ)。
    need = limit - len(cards)
    fallback = await get_fallback_ranking_movies(
        db,
        # 重複除去で枯れるリスクを下げるため少し多めに取得。
        limit=need * 2,
        window_days=_FALLBACK_WINDOW_DAYS[period],
        offset=0 if cards else offset,
    )
    for m in fallback:
        if len(cards) >= limit:
            break
        if m.id in seen_ids:
            continue
        cards.append(_to_card(m))
        seen_ids.add(m.id)
    return cards[:limit]


async def get_popular_all_time(
    db: AsyncSession,
    *,
    limit: int = 20,
    offset: int = 0,
) -> list[MovieCard]:
    """「人気」セクション: 全期間の watch_count (= 50%以上再生に到達したユニーク feed_session 数) 順。

    interaction_events ベースの watch_count を主指標にし、不足分は
    既存 view イベント / review_count フォールバックで穴埋めする。
    SQL OFFSET/LIMIT でページネーション。

    互換性メモ:
        従来は raw view イベント数を「総視聴回数」として並べていたが、
        フィード上の単なる通過 / 自動再生でも view が積み上がるため、
        2026-05 以降は「50% 到達ユニーク watch」を canonical な指標として採用する。
        watch_count が貯まるまでは aggregate_view_ranking_all_time + 既存
        フォールバックで補い、ユーザー体験を維持する。
    """
    ranked = await aggregate_watch_count_ranking_all_time(
        db, limit=limit, offset=offset
    )
    slugs = [s for s, _ in ranked if s]
    cards: list[MovieCard] = []
    seen_ids: set[str] = set()

    if slugs:
        movies = await get_movies_by_slugs_ordered(db, slugs)
        for m in movies:
            if m.id in seen_ids:
                continue
            cards.append(_to_card(m))
            seen_ids.add(m.id)

    if len(cards) >= limit:
        return cards[:limit]

    # watch_count 由来で limit に届かないときは、まず view イベント由来で補う。
    # interaction_events がまだ十分に貯まっていない初期段階で、
    # ホームの人気セクションが空になるのを防ぐためのフォールバック。
    need = limit - len(cards)
    view_ranked = await aggregate_view_ranking_all_time(
        db,
        limit=need * 2,
        offset=0 if cards else offset,
    )
    view_slugs = [s for s, _ in view_ranked if s]
    if view_slugs:
        view_movies = await get_movies_by_slugs_ordered(db, view_slugs)
        for m in view_movies:
            if len(cards) >= limit:
                break
            if m.id in seen_ids:
                continue
            cards.append(_to_card(m))
            seen_ids.add(m.id)

    if len(cards) >= limit:
        return cards[:limit]

    # 最終フォールバック: review_count ベースの汎用ランキング。
    need = limit - len(cards)
    fallback = await get_fallback_ranking_movies(
        db, limit=need * 2, window_days=None, offset=0 if cards else offset
    )
    for m in fallback:
        if len(cards) >= limit:
            break
        if m.id in seen_ids:
            continue
        cards.append(_to_card(m))
        seen_ids.add(m.id)
    return cards[:limit]


def _to_actress_card(actress) -> ActressCard:
    return ActressCard(
        id=actress.id,
        name=actress.name,
        slug=actress.slug,
        thumbnail_url=actress.thumbnail_url,
        image_url_small=actress.image_url_small,
        image_url_large=actress.image_url_large,
    )


def _to_goods_card(g) -> GoodsCard:
    return GoodsCard(
        id=g.id,
        content_id=g.content_id,
        title=g.title,
        slug=g.slug,
        image_url_list=g.image_url_list,
        image_url_large=g.image_url_large,
        affiliate_url=g.affiliate_url,
        price_list=g.price_list,
        price_min=g.price_min,
        review_count=g.review_count,
        review_average=(
            float(g.review_average) if g.review_average is not None else None
        ),
        maker_name=g.maker_name,
    )


async def get_popular_products_all_time(
    db: AsyncSession,
    *,
    limit: int = 20,
    offset: int = 0,
) -> list[GoodsCard]:
    """「人気商品」セクション: 商品 (Goods テーブル) から人気順に取得する。

    動画 (Movie) は対象外。商品単体での affiliate_click イベント発火導線が
    まだないため、review_count を主キーに review_average / primary_date を
    タイブレークにして並べる (goods_repository.get_popular_goods)。
    """
    goods = await get_popular_goods(db, limit=limit, offset=offset)
    return [_to_goods_card(g) for g in goods]


async def get_popular_actresses_all_time(
    db: AsyncSession,
    *,
    limit: int = 20,
    offset: int = 0,
) -> list[ActressCard]:
    """「人気女優」セクション: 全期間の affiliate_click イベントを女優単位に集計した順。

    affiliate_click イベントは Movie の slug に紐づくので、
    Event → Movie → MovieActress → Actress の JOIN で女優ごとの総クリック数を算出する。
    """
    ranked = await aggregate_affiliate_click_ranking_by_actress_all_time(
        db, limit=limit, offset=offset
    )
    ids = [aid for aid, _ in ranked]
    if not ids:
        return []
    actresses = await get_actresses_by_ids_ordered(db, ids)
    return [_to_actress_card(a) for a in actresses]


async def get_popular_search_genres(
    db: AsyncSession,
    *,
    period: str = "weekly",
    limit: int = 3,
) -> list[str]:
    """検索イベントを集計して、検索回数が多いクエリ Top N を返す。
    検索データが不足していたら空リストを返す (呼び元でフォールバック処理)。
    """
    ranked = await aggregate_search_query_ranking(db, period=period, limit=limit)
    return [q for q, _ in ranked if q]
