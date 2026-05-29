"""ランキングサービス (`ranking_service.get_ranking`) のロジックテスト。

DB に実接続せず、リポジトリ層 (`aggregate_view_ranking`,
`get_movies_by_slugs_ordered`, `get_fallback_ranking_movies`) を
monkeypatch で差し替えて、期間ごとに次の挙動を検証する:

1. period が `aggregate_view_ranking` にそのまま渡ること。
2. イベント由来で limit に満たない時にフォールバックで穴埋めされ、
   かつ daily/weekly/monthly でフォールバック窓幅が異なる
   (`_FALLBACK_WINDOW_DAYS`: 7/30/90日) ため並びが分かれること。
3. period ごとに `_FALLBACK_WINDOW_DAYS` が distinct な値であること
   (= 同じ window_days で違う期間を表現しない契約)。
4. イベントゼロのときは従来通りフォールバックだけで構成されること。
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.services import ranking_service


def _movie(i: int, *, slug: str | None = None):
    return SimpleNamespace(
        id=f"00000000-0000-0000-0000-{i:012d}",
        content_id=f"abc{i:05d}",
        title=f"テスト作品 {i:03d}",
        slug=slug or f"movie-{i:03d}",
        image_url_list=None,
        image_url_large=None,
        affiliate_url=f"https://example.com/{i}",
        price_list=None,
        price_min=None,
        review_count=0,
        review_average=None,
        actresses=[],
        genres=[],
        series=None,
        series_name=None,
    )


def test_fallback_window_days_distinct_per_period() -> None:
    """daily/weekly/monthly のフォールバック窓幅が distinct であること。

    値が被ると、イベントが完全ゼロの状況で全期間ランキングが
    再び同じ並びになってしまう。
    """
    values = list(ranking_service._FALLBACK_WINDOW_DAYS.values())
    assert len(set(values)) == 3
    # 期間が長くなるほど窓幅も広がるべき。
    assert (
        ranking_service._FALLBACK_WINDOW_DAYS["daily"]
        < ranking_service._FALLBACK_WINDOW_DAYS["weekly"]
        < ranking_service._FALLBACK_WINDOW_DAYS["monthly"]
    )


def test_get_ranking_passes_period_to_aggregate(monkeypatch: pytest.MonkeyPatch) -> None:
    """period が `aggregate_view_ranking` にそのまま渡されること。"""
    received: dict = {}

    async def fake_aggregate(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        received["period"] = period
        received["limit"] = limit
        received["offset"] = offset
        return []  # フォールバックに進ませる

    async def fake_fallback(db, *, limit, window_days, offset=0):  # type: ignore[no-untyped-def]
        return []

    monkeypatch.setattr(ranking_service, "aggregate_view_ranking", fake_aggregate)
    monkeypatch.setattr(ranking_service, "get_fallback_ranking_movies", fake_fallback)

    asyncio.run(ranking_service.get_ranking(None, period="weekly", limit=10, offset=5))  # type: ignore[arg-type]

    assert received == {"period": "weekly", "limit": 10, "offset": 5}


def test_get_ranking_uses_distinct_fallback_window_per_period(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """イベントゼロ時、daily/weekly/monthly で window_days が distinct な値で
    フォールバックが呼ばれること。
    """
    seen_windows: list[int | None] = []

    async def fake_aggregate(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        return []

    async def fake_fallback(db, *, limit, window_days, offset=0):  # type: ignore[no-untyped-def]
        seen_windows.append(window_days)
        return []

    monkeypatch.setattr(ranking_service, "aggregate_view_ranking", fake_aggregate)
    monkeypatch.setattr(ranking_service, "get_fallback_ranking_movies", fake_fallback)

    for p in ("daily", "weekly", "monthly"):
        asyncio.run(ranking_service.get_ranking(None, period=p, limit=10))  # type: ignore[arg-type]

    assert seen_windows == [
        ranking_service._FALLBACK_WINDOW_DAYS["daily"],
        ranking_service._FALLBACK_WINDOW_DAYS["weekly"],
        ranking_service._FALLBACK_WINDOW_DAYS["monthly"],
    ]
    assert len(set(seen_windows)) == 3


def test_get_ranking_fills_short_event_results_with_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """イベント由来の集計が limit に満たないとき、不足分を期間別の
    フォールバックで穴埋めすること。"""
    event_movie = _movie(1)

    async def fake_aggregate(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        # 1 件だけイベントから取れた状態を模擬
        return [(event_movie.slug, 5)]

    async def fake_get_by_slugs(db, slugs):  # type: ignore[no-untyped-def]
        return [event_movie]

    fallback_calls: list[dict] = []

    async def fake_fallback(db, *, limit, window_days, offset=0):  # type: ignore[no-untyped-def]
        fallback_calls.append(
            {"limit": limit, "window_days": window_days, "offset": offset}
        )
        # 重複を含めつつ複数件返す
        return [event_movie, _movie(2), _movie(3), _movie(4)]

    monkeypatch.setattr(ranking_service, "aggregate_view_ranking", fake_aggregate)
    monkeypatch.setattr(ranking_service, "get_movies_by_slugs_ordered", fake_get_by_slugs)
    monkeypatch.setattr(ranking_service, "get_fallback_ranking_movies", fake_fallback)

    out = asyncio.run(ranking_service.get_ranking(None, period="daily", limit=3))  # type: ignore[arg-type]

    # フォールバックが呼ばれた
    assert len(fallback_calls) == 1
    # daily の窓幅で呼ばれる
    assert fallback_calls[0]["window_days"] == ranking_service._FALLBACK_WINDOW_DAYS["daily"]
    # 重複除去で event_movie が二度入らない
    slugs = [c.slug for c in out]
    assert len(slugs) == len(set(slugs))
    assert len(out) == 3
    # 1 件目はイベント由来の作品
    assert out[0].slug == event_movie.slug


def test_get_ranking_skips_fallback_when_events_satisfy_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """イベント由来で limit を満たしていればフォールバックを呼ばないこと。"""
    movies = [_movie(i) for i in range(5)]

    async def fake_aggregate(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        return [(m.slug, 10 - i) for i, m in enumerate(movies)]

    async def fake_get_by_slugs(db, slugs):  # type: ignore[no-untyped-def]
        return movies

    fallback_called = False

    async def fake_fallback(db, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal fallback_called
        fallback_called = True
        return []

    monkeypatch.setattr(ranking_service, "aggregate_view_ranking", fake_aggregate)
    monkeypatch.setattr(ranking_service, "get_movies_by_slugs_ordered", fake_get_by_slugs)
    monkeypatch.setattr(ranking_service, "get_fallback_ranking_movies", fake_fallback)

    out = asyncio.run(ranking_service.get_ranking(None, period="weekly", limit=5))  # type: ignore[arg-type]

    assert len(out) == 5
    assert fallback_called is False


def test_get_ranking_invalid_period_raises() -> None:
    with pytest.raises(ValueError):
        asyncio.run(ranking_service.get_ranking(None, period="yearly"))  # type: ignore[arg-type]


def _goods(i: int):
    return SimpleNamespace(
        id=f"goods-{i:03d}",
        content_id=f"g{i:05d}",
        title=f"テスト商品 {i:03d}",
        slug=f"test-goods-{i:03d}",
        image_url_list=None,
        image_url_large=None,
        affiliate_url=f"https://example.com/goods/{i}",
        price_list=None,
        price_min=2980,
        review_count=10 - i,
        review_average=4.0,
        maker_name=None,
    )


def test_popular_products_returns_goods_only(monkeypatch: pytest.MonkeyPatch) -> None:
    """人気商品ランキングは Goods のみを対象にし、Movie は含まないこと。"""
    captured: dict = {}

    async def fake_get_popular_goods(db, *, limit, offset=0):  # type: ignore[no-untyped-def]
        captured["limit"] = limit
        captured["offset"] = offset
        return [_goods(i) for i in range(3)]

    # 動画系のフォールバックを呼んだら失敗扱いになるよう監視する
    movie_fallback_called = False

    async def fake_movie_fallback(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal movie_fallback_called
        movie_fallback_called = True
        return [SimpleNamespace(id="movie-1", slug="movie-1")]

    monkeypatch.setattr(ranking_service, "get_popular_goods", fake_get_popular_goods)
    monkeypatch.setattr(
        ranking_service, "get_fallback_ranking_movies", fake_movie_fallback
    )

    out = asyncio.run(
        ranking_service.get_popular_products_all_time(None, limit=5, offset=2)  # type: ignore[arg-type]
    )

    # 全部 GoodsCard で、Movie 由来のフォールバックは呼ばれない
    assert movie_fallback_called is False
    assert len(out) == 3
    for card in out:
        # GoodsCard には actresses / genres / series_name フィールドが無い
        assert not hasattr(card, "actresses")
        assert not hasattr(card, "genres")
        assert card.slug.startswith("test-goods-")
    # offset/limit がリポジトリに渡っていること
    assert captured == {"limit": 5, "offset": 2}


def test_popular_products_empty_when_no_goods(monkeypatch: pytest.MonkeyPatch) -> None:
    """Goods が 1 件もなければ空配列を返し、Movie で補完しないこと。"""

    async def fake_get_popular_goods(db, *, limit, offset=0):  # type: ignore[no-untyped-def]
        return []

    async def fake_movie_fallback(*args, **kwargs):  # type: ignore[no-untyped-def]
        # 呼ばれたらテスト失敗
        raise AssertionError("movie fallback must not be used for popular_products")

    monkeypatch.setattr(ranking_service, "get_popular_goods", fake_get_popular_goods)
    monkeypatch.setattr(
        ranking_service, "get_fallback_ranking_movies", fake_movie_fallback
    )

    out = asyncio.run(
        ranking_service.get_popular_products_all_time(None, limit=5)  # type: ignore[arg-type]
    )
    assert out == []


def test_popular_all_time_uses_watch_count_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`get_popular_all_time` は watch_count (50% 到達) を主指標として使うこと。

    watch_count の集計関数が呼ばれ、その slug 群が先頭に並ぶことを担保する。
    """
    movies = [_movie(i) for i in range(3)]
    watch_calls: list[dict] = []
    view_calls: list[dict] = []

    async def fake_watch(db, *, limit, offset=0):  # type: ignore[no-untyped-def]
        watch_calls.append({"limit": limit, "offset": offset})
        # watch_count: 0=10watch / 1=5watch / 2=1watch (3件で limit を満たす)
        return [(m.slug, 10 - i) for i, m in enumerate(movies)]

    async def fake_get_by_slugs(db, slugs):  # type: ignore[no-untyped-def]
        # 入力 slug の順を保つ
        by_slug = {m.slug: m for m in movies}
        return [by_slug[s] for s in slugs if s in by_slug]

    async def fake_view(db, *, limit, offset=0):  # type: ignore[no-untyped-def]
        view_calls.append({"limit": limit, "offset": offset})
        return []

    async def fake_fallback(db, **kwargs):  # type: ignore[no-untyped-def]
        raise AssertionError("fallback must not run when watch_count satisfies limit")

    monkeypatch.setattr(
        ranking_service, "aggregate_watch_count_ranking_all_time", fake_watch
    )
    monkeypatch.setattr(
        ranking_service, "get_movies_by_slugs_ordered", fake_get_by_slugs
    )
    monkeypatch.setattr(
        ranking_service, "aggregate_view_ranking_all_time", fake_view
    )
    monkeypatch.setattr(ranking_service, "get_fallback_ranking_movies", fake_fallback)

    out = asyncio.run(ranking_service.get_popular_all_time(None, limit=3))  # type: ignore[arg-type]

    # watch_count 集計が呼ばれている
    assert len(watch_calls) == 1
    # limit 分は watch_count 由来で埋まり、view イベントへフォールバックしない
    assert view_calls == []
    # 返却順は watch_count 降順
    assert [c.slug for c in out] == [m.slug for m in movies]


def test_popular_all_time_falls_back_to_view_then_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """watch_count が足りないときは view → review_count フォールバックの順で穴埋め。

    順番:
      1. watch_count で取れる分
      2. 既存 view イベント由来
      3. review_count ベース汎用フォールバック
    """
    m_watch = _movie(1, slug="movie-watch")
    m_view = _movie(2, slug="movie-view")
    m_fallback = _movie(3, slug="movie-fallback")

    async def fake_watch(db, *, limit, offset=0):  # type: ignore[no-untyped-def]
        return [(m_watch.slug, 5)]

    async def fake_get_by_slugs(db, slugs):  # type: ignore[no-untyped-def]
        by_slug = {m_watch.slug: m_watch, m_view.slug: m_view}
        return [by_slug[s] for s in slugs if s in by_slug]

    async def fake_view(db, *, limit, offset=0):  # type: ignore[no-untyped-def]
        return [(m_view.slug, 7)]

    async def fake_fallback(db, *, limit, window_days, offset=0):  # type: ignore[no-untyped-def]
        return [m_fallback]

    monkeypatch.setattr(
        ranking_service, "aggregate_watch_count_ranking_all_time", fake_watch
    )
    monkeypatch.setattr(
        ranking_service, "get_movies_by_slugs_ordered", fake_get_by_slugs
    )
    monkeypatch.setattr(
        ranking_service, "aggregate_view_ranking_all_time", fake_view
    )
    monkeypatch.setattr(ranking_service, "get_fallback_ranking_movies", fake_fallback)

    out = asyncio.run(ranking_service.get_popular_all_time(None, limit=3))  # type: ignore[arg-type]
    assert [c.slug for c in out] == [m_watch.slug, m_view.slug, m_fallback.slug]


def test_event_repository_since_distinct_per_period() -> None:
    """`_since` が daily/weekly/monthly でそれぞれ違う閾値を返すこと
    (期間 cutoff が混ざらないことの最小確認)。
    """
    from app.repositories.event_repository import _since

    daily = _since("daily")
    weekly = _since("weekly")
    monthly = _since("monthly")
    # weekly は daily より過去、monthly は weekly より過去
    assert weekly < daily
    assert monthly < weekly
