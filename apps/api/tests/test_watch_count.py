"""watch_count 集計 (interaction_event_repository) の単体テスト。

watch_count の canonical 定義:
  「ある作品について、1 つの feed_session が 25% 以上再生に到達した」ら 1 watch。
  含むイベント:
    - event_name='play_progress' AND (progress_milestone >= 25 OR progress_ratio >= 0.25)
    - event_name='video_complete'
  デデュープ:
    同一 feed_session_id + slug が複数 watch event を起こしても 1 watch。

本テストは pytest が DB に実接続しない方針 (conftest.py 参照) に従い、
SQLAlchemy の Core を使って in-memory SQLite を立ち上げ、リポジトリ関数を
実 SQL 経由で動かすことで「25% 閾値 + COUNT(DISTINCT) デデュープ」の振る舞いを
担保する。
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from app.repositories import interaction_event_repository as iev_repo


async def _make_engine_and_session():
    """SQLite (aiosqlite) の in-memory DB に必要テーブルだけ作る。

    PostgreSQL 専用型 (JSONB 等) は SQLite で compile できないため、
    watch_count 集計に必要なカラムだけを raw DDL で作る。
    集計に使うのは event_name / slug / feed_session_id /
    progress_milestone / progress_ratio + movies.is_visible だけなので
    十分。
    """
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.execute(
            text(
                """
                CREATE TABLE interaction_events (
                    id TEXT PRIMARY KEY,
                    event_name TEXT NOT NULL,
                    slug TEXT,
                    feed_session_id TEXT,
                    progress_milestone INTEGER,
                    progress_ratio REAL,
                    created_at TIMESTAMP
                )
                """
            )
        )
        await conn.execute(
            text(
                """
                CREATE TABLE movies (
                    id TEXT PRIMARY KEY,
                    slug TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL,
                    content_id TEXT,
                    affiliate_url TEXT,
                    is_visible INTEGER NOT NULL DEFAULT 1
                )
                """
            )
        )
    Session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return engine, Session


async def _insert_event(
    s: AsyncSession,
    *,
    slug: str | None,
    event_name: str,
    feed_session_id: str | None = None,
    progress_milestone: int | None = None,
    progress_ratio: float | None = None,
    created_at: datetime | None = None,
) -> None:
    await s.execute(
        text(
            "INSERT INTO interaction_events "
            "(id, event_name, slug, feed_session_id, progress_milestone, progress_ratio, created_at) "
            "VALUES (:id, :event_name, :slug, :fsid, :ms, :pr, :created_at)"
        ),
        {
            "id": str(uuid.uuid4()),
            "event_name": event_name,
            "slug": slug,
            "fsid": feed_session_id,
            "ms": progress_milestone,
            "pr": progress_ratio,
            "created_at": (
                created_at
                if created_at is not None
                else datetime.now(timezone.utc).replace(tzinfo=None)
            ),
        },
    )


async def _insert_movie(s: AsyncSession, slug: str, *, visible: bool = True) -> None:
    await s.execute(
        text(
            "INSERT INTO movies (id, slug, title, content_id, affiliate_url, is_visible) "
            "VALUES (:id, :slug, :title, :cid, :aff, :vis)"
        ),
        {
            "id": str(uuid.uuid4()),
            "slug": slug,
            "title": f"title for {slug}",
            "cid": f"cid_{slug}",
            "aff": f"https://example.com/{slug}",
            "vis": 1 if visible else 0,
        },
    )


# ─────────────────────────────────────────────
# watch_count per slug
# ─────────────────────────────────────────────


def test_get_watch_count_returns_zero_when_no_events() -> None:
    async def run() -> None:
        engine, Session = await _make_engine_and_session()
        try:
            async with Session() as s:
                await _insert_movie(s, "slug-a")
                await s.commit()
                got = await iev_repo.get_watch_count_for_slug(s, "slug-a")
                assert got == 0
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_get_watch_count_counts_video_complete() -> None:
    """video_complete は無条件で watch にカウントされる。"""

    async def run() -> None:
        engine, Session = await _make_engine_and_session()
        try:
            async with Session() as s:
                await _insert_movie(s, "slug-a")
                await _insert_event(
                    s,
                    slug="slug-a",
                    event_name="video_complete",
                    feed_session_id="sess-1",
                )
                await s.commit()
                assert await iev_repo.get_watch_count_for_slug(s, "slug-a") == 1
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_get_watch_count_25_threshold_via_milestone() -> None:
    """progress_milestone >= 25 が watch にカウントされる。25% 未満は除外。"""

    async def run() -> None:
        engine, Session = await _make_engine_and_session()
        try:
            async with Session() as s:
                await _insert_movie(s, "slug-a")
                # 10% は watch ではない (25% 未満)
                await _insert_event(
                    s,
                    slug="slug-a",
                    event_name="play_progress",
                    feed_session_id="sess-0",
                    progress_milestone=10,
                )
                # 25% は watch
                await _insert_event(
                    s,
                    slug="slug-a",
                    event_name="play_progress",
                    feed_session_id="sess-1",
                    progress_milestone=25,
                )
                # 50% は watch
                await _insert_event(
                    s,
                    slug="slug-a",
                    event_name="play_progress",
                    feed_session_id="sess-2",
                    progress_milestone=50,
                )
                # 75% は当然 watch
                await _insert_event(
                    s,
                    slug="slug-a",
                    event_name="play_progress",
                    feed_session_id="sess-3",
                    progress_milestone=75,
                )
                await s.commit()
                assert await iev_repo.get_watch_count_for_slug(s, "slug-a") == 3
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_get_watch_count_25_threshold_via_ratio() -> None:
    """progress_milestone が無くても progress_ratio >= 0.25 なら watch。"""

    async def run() -> None:
        engine, Session = await _make_engine_and_session()
        try:
            async with Session() as s:
                await _insert_movie(s, "slug-a")
                # 24% 相当は watch ではない
                await _insert_event(
                    s,
                    slug="slug-a",
                    event_name="play_progress",
                    feed_session_id="sess-1",
                    progress_ratio=0.24,
                )
                # 25% ちょうどは watch
                await _insert_event(
                    s,
                    slug="slug-a",
                    event_name="play_progress",
                    feed_session_id="sess-2",
                    progress_ratio=0.25,
                )
                await s.commit()
                assert await iev_repo.get_watch_count_for_slug(s, "slug-a") == 1
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_get_watch_count_dedupes_same_feed_session() -> None:
    """同じ feed_session_id + slug の watch event が複数回飛んでも 1 watch。"""

    async def run() -> None:
        engine, Session = await _make_engine_and_session()
        try:
            async with Session() as s:
                await _insert_movie(s, "slug-a")
                # 同じ feed_session が 50/75/complete を順に発火するケース。
                for ms in (50, 75):
                    await _insert_event(
                        s,
                        slug="slug-a",
                        event_name="play_progress",
                        feed_session_id="sess-1",
                        progress_milestone=ms,
                    )
                await _insert_event(
                    s,
                    slug="slug-a",
                    event_name="video_complete",
                    feed_session_id="sess-1",
                )
                # 別のセッションは別 watch
                await _insert_event(
                    s,
                    slug="slug-a",
                    event_name="play_progress",
                    feed_session_id="sess-2",
                    progress_milestone=50,
                )
                await s.commit()
                assert await iev_repo.get_watch_count_for_slug(s, "slug-a") == 2
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_get_watch_count_anonymous_null_session_counted_as_distinct_rows() -> None:
    """feed_session_id が NULL の watch event は、行ごとに 1 watch として保守的に数える。

    識別子が無いと「同一視聴者」かを判定できないため、現在の振る舞いとして
    各行を区別する (= ドキュメントに明記)。
    """

    async def run() -> None:
        engine, Session = await _make_engine_and_session()
        try:
            async with Session() as s:
                await _insert_movie(s, "slug-a")
                await _insert_event(
                    s,
                    slug="slug-a",
                    event_name="play_progress",
                    feed_session_id=None,
                    progress_milestone=50,
                )
                await _insert_event(
                    s,
                    slug="slug-a",
                    event_name="play_progress",
                    feed_session_id=None,
                    progress_milestone=75,
                )
                await s.commit()
                # NULL feed_session_id は id でデデュープされるため 2 watch。
                assert await iev_repo.get_watch_count_for_slug(s, "slug-a") == 2
        finally:
            await engine.dispose()

    asyncio.run(run())


# ─────────────────────────────────────────────
# watch_count ランキング集計
# ─────────────────────────────────────────────


def test_watch_count_ranking_orders_by_dedup_count() -> None:
    """popular ランキングは「25% 到達ユニーク feed_session 数」順に並ぶ。

    raw event 数ではなくユニーク feed_session 数で比較されることを担保するため、
    slug-low に大量のイベントを同 feed_session で発火させても勝てないことを確認する。
    """

    async def run() -> None:
        engine, Session = await _make_engine_and_session()
        try:
            async with Session() as s:
                await _insert_movie(s, "slug-high")
                await _insert_movie(s, "slug-low")
                # slug-high: 2 ユニーク feed_session が 50% 以上に到達。
                await _insert_event(
                    s,
                    slug="slug-high",
                    event_name="play_progress",
                    feed_session_id="h1",
                    progress_milestone=50,
                )
                await _insert_event(
                    s,
                    slug="slug-high",
                    event_name="video_complete",
                    feed_session_id="h2",
                )
                # slug-low: 1 feed_session が 50/75/complete を連発しても 1 watch
                for ms in (50, 75):
                    await _insert_event(
                        s,
                        slug="slug-low",
                        event_name="play_progress",
                        feed_session_id="l1",
                        progress_milestone=ms,
                    )
                await _insert_event(
                    s,
                    slug="slug-low",
                    event_name="video_complete",
                    feed_session_id="l1",
                )
                await s.commit()

                ranked = await iev_repo.aggregate_watch_count_ranking_all_time(
                    s, limit=10, offset=0
                )
                # 順位: slug-high (2 watch) > slug-low (1 watch)
                assert ranked[0] == ("slug-high", 2)
                assert ranked[1] == ("slug-low", 1)
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_watch_count_ranking_excludes_invisible_movies() -> None:
    """is_visible=False の作品はランキングから除外される。"""

    async def run() -> None:
        engine, Session = await _make_engine_and_session()
        try:
            async with Session() as s:
                await _insert_movie(s, "slug-visible", visible=True)
                await _insert_movie(s, "slug-hidden", visible=False)
                await _insert_event(
                    s,
                    slug="slug-visible",
                    event_name="video_complete",
                    feed_session_id="v1",
                )
                await _insert_event(
                    s,
                    slug="slug-hidden",
                    event_name="video_complete",
                    feed_session_id="h1",
                )
                await _insert_event(
                    s,
                    slug="slug-hidden",
                    event_name="video_complete",
                    feed_session_id="h2",
                )
                await s.commit()
                ranked = await iev_repo.aggregate_watch_count_ranking_all_time(
                    s, limit=10
                )
                slugs = [slug for slug, _ in ranked]
                assert slugs == ["slug-visible"]
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_watch_count_ranking_skips_below_25_threshold() -> None:
    """25% 未満で止まったセッションは watch にカウントされない (= ランキングに出ない)。"""

    async def run() -> None:
        engine, Session = await _make_engine_and_session()
        try:
            async with Session() as s:
                await _insert_movie(s, "slug-a")
                await _insert_movie(s, "slug-b")
                await _insert_event(
                    s,
                    slug="slug-a",
                    event_name="play_progress",
                    feed_session_id="a1",
                    progress_milestone=10,
                )
                await _insert_event(
                    s,
                    slug="slug-b",
                    event_name="play_progress",
                    feed_session_id="b1",
                    progress_milestone=50,
                )
                await s.commit()
                ranked = await iev_repo.aggregate_watch_count_ranking_all_time(
                    s, limit=10
                )
                assert ranked == [("slug-b", 1)]
        finally:
            await engine.dispose()

    asyncio.run(run())


# ─────────────────────────────────────────────
# 期間付き watch_count ランキング (daily / weekly / monthly)
# ─────────────────────────────────────────────


def _naive_utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def test_period_window_excludes_old_events_daily() -> None:
    """daily ランキングは 24 時間より古い watch event を除外する。"""

    async def run() -> None:
        engine, Session = await _make_engine_and_session()
        try:
            now = _naive_utc_now()
            async with Session() as s:
                await _insert_movie(s, "slug-fresh")
                await _insert_movie(s, "slug-old")
                # daily 内 (12h 前)
                await _insert_event(
                    s,
                    slug="slug-fresh",
                    event_name="play_progress",
                    feed_session_id="f1",
                    progress_milestone=50,
                    created_at=now - timedelta(hours=12),
                )
                # daily 外 (48h 前) → 除外される
                await _insert_event(
                    s,
                    slug="slug-old",
                    event_name="play_progress",
                    feed_session_id="o1",
                    progress_milestone=50,
                    created_at=now - timedelta(hours=48),
                )
                await s.commit()
                ranked = await iev_repo.aggregate_watch_count_ranking(
                    s, period="daily", limit=10
                )
                assert ranked == [("slug-fresh", 1)]
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_period_window_includes_weekly_but_excludes_monthly_boundary() -> None:
    """weekly は 7 日以内、monthly は 30 日以内のみを集計対象とする。"""

    async def run() -> None:
        engine, Session = await _make_engine_and_session()
        try:
            now = _naive_utc_now()
            async with Session() as s:
                await _insert_movie(s, "slug-day1")
                await _insert_movie(s, "slug-day10")
                await _insert_movie(s, "slug-day40")
                # 1 日前 (weekly / monthly どちらにも入る)
                await _insert_event(
                    s,
                    slug="slug-day1",
                    event_name="play_progress",
                    feed_session_id="d1",
                    progress_milestone=50,
                    created_at=now - timedelta(days=1),
                )
                # 10 日前 (weekly 圏外 / monthly 圏内)
                await _insert_event(
                    s,
                    slug="slug-day10",
                    event_name="play_progress",
                    feed_session_id="d10",
                    progress_milestone=50,
                    created_at=now - timedelta(days=10),
                )
                # 40 日前 (どちらも圏外)
                await _insert_event(
                    s,
                    slug="slug-day40",
                    event_name="play_progress",
                    feed_session_id="d40",
                    progress_milestone=50,
                    created_at=now - timedelta(days=40),
                )
                await s.commit()

                weekly = await iev_repo.aggregate_watch_count_ranking(
                    s, period="weekly", limit=10
                )
                assert [slug for slug, _ in weekly] == ["slug-day1"]

                monthly = await iev_repo.aggregate_watch_count_ranking(
                    s, period="monthly", limit=10
                )
                # monthly は day1 と day10 を含む。順番は last_watch 降順なので
                # 直近 (day1) → やや古め (day10)。
                assert [slug for slug, _ in monthly] == ["slug-day1", "slug-day10"]
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_period_window_dedupes_within_period() -> None:
    """期間ウィンドウ内でも (slug, feed_session_id) によるデデュープが効くこと。"""

    async def run() -> None:
        engine, Session = await _make_engine_and_session()
        try:
            now = _naive_utc_now()
            async with Session() as s:
                await _insert_movie(s, "slug-a")
                # 同一 feed_session が daily 期間内に複数回 watch event を吐く
                for ms in (50, 75):
                    await _insert_event(
                        s,
                        slug="slug-a",
                        event_name="play_progress",
                        feed_session_id="dup",
                        progress_milestone=ms,
                        created_at=now - timedelta(hours=1),
                    )
                await _insert_event(
                    s,
                    slug="slug-a",
                    event_name="video_complete",
                    feed_session_id="dup",
                    created_at=now - timedelta(minutes=30),
                )
                # 同期間内の別セッション
                await _insert_event(
                    s,
                    slug="slug-a",
                    event_name="play_progress",
                    feed_session_id="other",
                    progress_milestone=50,
                    created_at=now - timedelta(hours=2),
                )
                await s.commit()
                ranked = await iev_repo.aggregate_watch_count_ranking(
                    s, period="daily", limit=10
                )
                assert ranked == [("slug-a", 2)]
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_period_window_skips_below_25_threshold() -> None:
    """期間ランキングでも 25% 未満で止まったセッションは watch にカウントされない。"""

    async def run() -> None:
        engine, Session = await _make_engine_and_session()
        try:
            now = _naive_utc_now()
            async with Session() as s:
                await _insert_movie(s, "slug-10")
                await _insert_movie(s, "slug-50")
                await _insert_event(
                    s,
                    slug="slug-10",
                    event_name="play_progress",
                    feed_session_id="a",
                    progress_milestone=10,
                    created_at=now - timedelta(hours=1),
                )
                await _insert_event(
                    s,
                    slug="slug-50",
                    event_name="play_progress",
                    feed_session_id="b",
                    progress_milestone=50,
                    created_at=now - timedelta(hours=1),
                )
                await s.commit()
                ranked = await iev_repo.aggregate_watch_count_ranking(
                    s, period="weekly", limit=10
                )
                assert ranked == [("slug-50", 1)]
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_watch_count_ranking_only_returns_positive_counts() -> None:
    """HAVING c > 0 を強制している契約のリグレッション。

    10% 止まり (25% 未満なので watch event ではない) しか持たない作品が、
    ランキング集計の結果として `(slug, 0)` のように返ってくると、上位ランクの
    service 側が「watch_count > 0 として扱う」誤動作を起こしうる。
    そもそも返さない (= ランキングに混ぜない) ことを保証する。
    """

    async def run() -> None:
        engine, Session = await _make_engine_and_session()
        try:
            now = _naive_utc_now()
            async with Session() as s:
                await _insert_movie(s, "slug-10-only")
                await _insert_movie(s, "slug-50")
                # 10% 止まり (25% 未満 = watch event ではない) → 集計対象に上がらない
                await _insert_event(
                    s,
                    slug="slug-10-only",
                    event_name="play_progress",
                    feed_session_id="a",
                    progress_milestone=10,
                    created_at=now - timedelta(hours=1),
                )
                # 50% 到達 → watch event
                await _insert_event(
                    s,
                    slug="slug-50",
                    event_name="play_progress",
                    feed_session_id="b",
                    progress_milestone=50,
                    created_at=now - timedelta(hours=1),
                )
                await s.commit()
                # 全期間 / 期間付きの双方で slug-10-only は返らない
                all_time = await iev_repo.aggregate_watch_count_ranking_all_time(
                    s, limit=10
                )
                assert [slug for slug, _ in all_time] == ["slug-50"]
                for _, c in all_time:
                    assert c > 0

                weekly = await iev_repo.aggregate_watch_count_ranking(
                    s, period="weekly", limit=10
                )
                assert [slug for slug, _ in weekly] == ["slug-50"]
                for _, c in weekly:
                    assert c > 0
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_period_invalid_raises() -> None:
    """未知の period は ValueError。"""

    async def run() -> None:
        engine, Session = await _make_engine_and_session()
        try:
            async with Session() as s:
                try:
                    await iev_repo.aggregate_watch_count_ranking(
                        s, period="yearly", limit=10
                    )
                except ValueError:
                    return
                raise AssertionError("expected ValueError for unknown period")
        finally:
            await engine.dispose()

    asyncio.run(run())
