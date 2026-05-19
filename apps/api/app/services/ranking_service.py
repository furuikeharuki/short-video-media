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
    aggregate_view_ranking_all_time,
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
    """「人気」セクション: 全期間の view イベント計順。
    view イベントが不足しているときは全体の review_count 順 (windowなし) で補う。
    SQL OFFSET/LIMIT でページネーション。
    """
    ranked = await aggregate_view_ranking_all_time(db, limit=limit, offset=offset)
    slugs = [s for s, _ in ranked if s]

    if slugs:
        movies = await get_movies_by_slugs_ordered(db, slugs)
        if movies:
            return [_to_card(m) for m in movies]

    movies = await get_fallback_ranking_movies(
        db, limit=limit, window_days=None, offset=offset
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
