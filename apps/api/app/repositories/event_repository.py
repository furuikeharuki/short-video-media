from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.event import Event
from app.db.models.movie import Movie


ALLOWED_EVENT_TYPES = {
    "view",
    "play",
    "detail_click",
    "affiliate_click",
    "search",
}


async def insert_event(
    db: AsyncSession,
    *,
    event_type: str,
    slug: str | None = None,
    title: str | None = None,
    affiliate_url: str | None = None,
    next_path: str | None = None,
    search_query: str | None = None,
) -> Event:
    ev = Event(
        event_type=event_type,
        slug=slug,
        title=title,
        affiliate_url=affiliate_url,
        next_path=next_path,
        search_query=search_query,
    )
    db.add(ev)
    await db.commit()
    return ev


def _since(period: str) -> datetime:
    """daily=24h, weekly=7d, monthly=30d 前の閾値を返す。

    　events.created_at カラムは TIMESTAMP WITHOUT TIME ZONE (naive UTC) なので、
    　比較オペランドも naive UTC で揃える。
    　(aware datetime を渡すと asyncpg が can't subtract offset-naive and
    　 offset-aware datetimes エラーを投げる)
    """
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if period == "daily":
        return now - timedelta(days=1)
    if period == "weekly":
        return now - timedelta(days=7)
    if period == "monthly":
        return now - timedelta(days=30)
    raise ValueError(f"unknown period: {period}")


async def aggregate_view_ranking(
    db: AsyncSession,
    *,
    period: str,
    limit: int = 20,
    offset: int = 0,
) -> list[tuple[str, int]]:
    """期間内の event_type='view' を slug 単位で集計し、(slug, count) を降順で返す。

    現在 movies テーブルに存在している slug のみを集計対象とする。
    (DB リセット前のレガシー slug や、sync で除外された slug を上位に出さない)

    offset/limit を SQL レベルで適用するので、データが何件あっても
    1 ページあたりの計算量は limit 件だけ。
    """
    since = _since(period)
    stmt = (
        select(Event.slug, func.count(Event.id).label("c"))
        .join(Movie, Movie.slug == Event.slug)
        .where(
            Event.event_type == "view",
            Event.slug.is_not(None),
            Event.created_at >= since,
            Movie.is_visible.is_(True),
        )
        .group_by(Event.slug)
        # 二次キーに slug を与えてソートを安定化させる。
        # (count の tie でページごとに順序が変わってしまうと、
        #  クライアント側で重複・欠落が起きるため)
        .order_by(desc("c"), Event.slug)
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    return [(row[0], int(row[1])) for row in result.all()]


async def aggregate_view_ranking_all_time(
    db: AsyncSession,
    *,
    limit: int = 20,
    offset: int = 0,
) -> list[tuple[str, int]]:
    """全期間の event_type='view' を slug 単位で集計し、(slug, count) を降順で返す。「人気」セクション用。

    現在 movies テーブルに存在している slug のみを集計対象とする。
    SQL レベルで offset/limit を適用。
    """
    stmt = (
        select(Event.slug, func.count(Event.id).label("c"))
        .join(Movie, Movie.slug == Event.slug)
        .where(
            Event.event_type == "view",
            Event.slug.is_not(None),
            Movie.is_visible.is_(True),
        )
        .group_by(Event.slug)
        # ページネーション安定化のため二次キーを追加。
        .order_by(desc("c"), Event.slug)
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    return [(row[0], int(row[1])) for row in result.all()]


async def aggregate_search_query_ranking(
    db: AsyncSession,
    *,
    period: str = "weekly",
    limit: int = 10,
) -> list[tuple[str, int]]:
    """期間内の search イベントを search_query 単位で集計し、(query, count) を降順で返す。"""
    since = _since(period)
    stmt = (
        select(Event.search_query, func.count(Event.id).label("c"))
        .where(
            Event.event_type == "search",
            Event.search_query.is_not(None),
            Event.created_at >= since,
        )
        .group_by(Event.search_query)
        .order_by(desc("c"))
        .limit(limit)
    )
    result = await db.execute(stmt)
    return [(row[0], int(row[1])) for row in result.all()]
