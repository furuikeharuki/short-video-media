"""interaction_events 永続化レイヤ。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import case, desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.interaction_event import InteractionEvent
from app.db.models.movie import Movie


# 期間ランキング用のウィンドウ幅。event_repository._since と揃え、
# raw view 由来のランキングと watch_count 由来のランキングが同じ「期間」
# の定義 (UTC, naive) で動作するようにする。
_PERIOD_DAYS: dict[str, int] = {
    "daily": 1,
    "weekly": 7,
    "monthly": 30,
}


def _since_for_period(period: str) -> datetime:
    """daily=24h, weekly=7d, monthly=30d 前の naive UTC 閾値。

    interaction_events.created_at は (events と同様) TIMESTAMP WITHOUT TIME ZONE
    なので、比較オペランドも naive UTC で揃える必要がある。aware を渡すと
    asyncpg が「offset-naive と offset-aware の差を取れない」と例外を出す。
    """
    if period not in _PERIOD_DAYS:
        raise ValueError(f"unknown period: {period}")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    return now - timedelta(days=_PERIOD_DAYS[period])


# クライアントから受け付ける event_name の語彙。schemas 側の Pydantic で
# 長さチェックはしているが、未知の名前で DB が汚れるのを防ぐためここで限定する。
# 増やすときは frontend `analytics/interactions.ts` と一緒に更新する。
ALLOWED_INTERACTION_EVENTS: set[str] = {
    # 表示系
    "impression",
    # 再生ライフサイクル
    "play",
    "play_progress",
    "video_complete",
    "pause",
    "resume",
    "replay",
    "dwell",
    # スワイプ / スキップ
    "skip",
    "swipe",
    # 音量
    "mute",
    "unmute",
    # ページライフサイクル
    "page_hidden",
    "page_visible",
}


async def insert_interaction_event(
    db: AsyncSession,
    *,
    event_name: str,
    slug: str | None = None,
    feed_session_id: str | None = None,
    feed_position: int | None = None,
    session_seq: int | None = None,
    surface: str | None = None,
    rec_source: str | None = None,
    progress_ratio: float | None = None,
    progress_milestone: int | None = None,
    current_time_sec: float | None = None,
    duration_sec: float | None = None,
    elapsed_ms: int | None = None,
    direction: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> InteractionEvent:
    ev = InteractionEvent(
        event_name=event_name,
        slug=slug,
        feed_session_id=feed_session_id,
        feed_position=feed_position,
        session_seq=session_seq,
        surface=surface,
        rec_source=rec_source,
        progress_ratio=progress_ratio,
        progress_milestone=progress_milestone,
        current_time_sec=current_time_sec,
        duration_sec=duration_sec,
        elapsed_ms=elapsed_ms,
        direction=direction,
        event_metadata=metadata,
    )
    db.add(ev)
    await db.commit()
    return ev


# ─────────────────────────────────────────────
# watch_count 集計
# ─────────────────────────────────────────────
# watch_count の定義 (canonical):
#   「ある作品について、ユーザー (= feed_session) が 50% 以上再生に到達した」ら 1 watch。
#   具体的には interaction_events のうち以下のいずれかを満たすレコードを「watch event」とみなす:
#     - event_name='play_progress' AND (progress_milestone >= 50 OR progress_ratio >= 0.5)
#     - event_name='video_complete' (100% 到達なので必ず watch に該当)
#
# デデュープ:
#   同一 feed_session_id + slug で複数の 50/75/100/complete イベントが飛んでも
#   1 watch にしか数えない (COUNT(DISTINCT feed_session_id))。
#   feed_session_id が NULL のレコードは、互いを区別する識別子がないため
#   現在の interaction_event 1 件をそのまま 1 watch として保守的に数える
#   (こうすると本来 1 セッションでも複数 watch にカウントされうるが、
#    本来 feed_session_id は常に発行される設計のため発生頻度は低い。
#    将来 IP / ua ハッシュなど別の弱識別子を導入する場合はここを差し替える)。


def _watch_event_filter():
    """watch_count を構成する interaction_events 行の WHERE 句。

    play_progress 系 (50% 以上) と video_complete の両方を含む。
    """
    return or_(
        InteractionEvent.event_name == "video_complete",
        (InteractionEvent.event_name == "play_progress")
        & (
            (InteractionEvent.progress_milestone >= 50)
            | (InteractionEvent.progress_ratio >= 0.5)
        ),
    )


def _distinct_watch_count_expr():
    """1 watch = 1 (feed_session_id, slug) ペア。

    feed_session_id が NULL の行は識別子が無いため、
    その場合に限り interaction_event.id を識別子として使う
    (= 該当行 1 件を 1 watch として数える)。
    こうすると NULL 行同士が同一セッションでも区別される副作用はあるが、
    feed_session_id が常に発行される現行設計では稀。
    """
    key = case(
        (
            InteractionEvent.feed_session_id.is_not(None),
            InteractionEvent.feed_session_id,
        ),
        else_=InteractionEvent.id,
    )
    return func.count(func.distinct(key))


async def get_watch_count_for_slug(db: AsyncSession, slug: str) -> int:
    """1 作品 (slug) の watch_count を返す。

    interaction_events が無ければ 0。
    """
    stmt = (
        select(_distinct_watch_count_expr())
        .where(
            InteractionEvent.slug == slug,
            _watch_event_filter(),
        )
    )
    result = await db.execute(stmt)
    value = result.scalar_one_or_none()
    return int(value) if value is not None else 0


async def aggregate_watch_count_ranking_all_time(
    db: AsyncSession,
    *,
    limit: int = 20,
    offset: int = 0,
) -> list[tuple[str, int]]:
    """全期間の watch_count を slug 単位で集計し、(slug, count) を降順で返す。

    現在 movies テーブルに存在している可視 slug のみを集計対象にする。
    SQL レベルで OFFSET/LIMIT を適用。

    HAVING c > 0 を明示しているのは防御的契約: 「watch_count ランキングに
    返ってきた slug は必ず watch_count > 0」。watch_event WHERE フィルタを
    通った行を GROUP BY すれば理論上 0 にはならないが、フィルタの拡張や
    将来の DB 仕様変化で 0 件 group が混入したときに、ランキング service
    側がそれを「見かけ 1 watch」として扱ってしまうのを防ぐ。
    """
    c = _distinct_watch_count_expr().label("c")
    stmt = (
        select(InteractionEvent.slug, c)
        .join(Movie, Movie.slug == InteractionEvent.slug)
        .where(
            InteractionEvent.slug.is_not(None),
            _watch_event_filter(),
            Movie.is_visible.is_(True),
        )
        .group_by(InteractionEvent.slug)
        .having(c > 0)
        .order_by(desc("c"), InteractionEvent.slug)
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    return [(row[0], int(row[1])) for row in result.all()]


async def aggregate_watch_count_ranking(
    db: AsyncSession,
    *,
    period: str,
    limit: int = 20,
    offset: int = 0,
) -> list[tuple[str, int]]:
    """期間 (daily=24h / weekly=7d / monthly=30d) 内の watch_count を slug 単位で
    集計し、(slug, count) を降順で返す。

    canonical 定義は全期間版と同じ:
      - event_name='video_complete' か、
        event_name='play_progress' で 50% 以上に到達した行を watch event とみなし、
      - (slug, feed_session_id) で COUNT(DISTINCT) によりデデュープ。
      - feed_session_id が NULL の行は interaction_event.id でデデュープ。

    違いは「期間ウィンドウを `created_at >= now - N日` で絞る」だけ。

    Tie-break:
      - 一次キー: watch_count desc
      - 二次キー: 期間内で最後に起きた watch event の時刻 (last_watch desc)
        全期間 raw view 由来ランキング (`aggregate_view_ranking`) と方針を揃え、
        count tie のとき daily/weekly/monthly が完全に同じ並びになるのを避ける。
      - 三次キー: slug (ページネーション安定化)
    """
    since = _since_for_period(period)
    c = _distinct_watch_count_expr().label("c")
    last_watch = func.max(InteractionEvent.created_at).label("last_watch")
    stmt = (
        select(InteractionEvent.slug, c, last_watch)
        .join(Movie, Movie.slug == InteractionEvent.slug)
        .where(
            InteractionEvent.slug.is_not(None),
            _watch_event_filter(),
            InteractionEvent.created_at >= since,
            Movie.is_visible.is_(True),
        )
        .group_by(InteractionEvent.slug)
        # HAVING c > 0: 全期間版と同じ防御契約。watch_count=0 の slug が
        # フォールバックを差し置いて #1 になる事故を防ぐ。
        .having(c > 0)
        .order_by(desc("c"), desc("last_watch"), InteractionEvent.slug)
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    return [(row[0], int(row[1])) for row in result.all()]
