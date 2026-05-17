"""ランキング集計サービス。

イベントテーブル (event_type='view') を集計してランキングを作る。
データが不足しているときは review_count / review_average ベースの
代替ランキングにフォールバックする。
"""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.event_repository import (
    aggregate_search_query_ranking,
    aggregate_view_ranking,
)
from app.repositories.movie_repository import (
    get_fallback_ranking_movies,
    get_movies_by_slugs_ordered,
)
from app.services.feed_service import _to_card
from app.schemas.movie import MovieCard


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
) -> list[MovieCard]:
    if period not in VALID_PERIODS:
        raise ValueError(f"period must be one of {VALID_PERIODS}")

    ranked = await aggregate_view_ranking(db, period=period, limit=limit)
    slugs = [s for s, _ in ranked if s]

    if slugs:
        movies = await get_movies_by_slugs_ordered(db, slugs)
        if movies:
            return [_to_card(m) for m in movies]

    # フォールバック: イベントデータ不足のとき
    movies = await get_fallback_ranking_movies(
        db, limit=limit, window_days=_FALLBACK_WINDOW_DAYS[period]
    )
    return [_to_card(m) for m in movies]


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
