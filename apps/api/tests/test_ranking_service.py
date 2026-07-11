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


def test_get_ranking_passes_period_to_watch_count_aggregate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """period が主指標である `aggregate_watch_count_ranking` にそのまま渡されること。"""
    received: dict = {}

    async def fake_watch(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        received["period"] = period
        received["limit"] = limit
        received["offset"] = offset
        return []  # フォールバックに進ませる

    async def fake_view(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        return []

    async def fake_fallback(db, *, limit, window_days, offset=0):  # type: ignore[no-untyped-def]
        return []

    monkeypatch.setattr(ranking_service, "aggregate_watch_count_ranking", fake_watch)
    monkeypatch.setattr(ranking_service, "aggregate_view_ranking", fake_view)
    monkeypatch.setattr(ranking_service, "get_fallback_ranking_movies", fake_fallback)

    asyncio.run(ranking_service.get_ranking(None, period="weekly", limit=10, offset=5))  # type: ignore[arg-type]

    assert received == {"period": "weekly", "limit": 10, "offset": 5}


def test_get_ranking_watch_count_passes_each_period(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """daily/weekly/monthly いずれの呼び出しでも、watch_count 集計に同じ
    period が渡されること。
    """
    seen_periods: list[str] = []

    async def fake_watch(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        seen_periods.append(period)
        return []

    async def fake_view(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        return []

    async def fake_fallback(db, *, limit, window_days, offset=0):  # type: ignore[no-untyped-def]
        return []

    monkeypatch.setattr(ranking_service, "aggregate_watch_count_ranking", fake_watch)
    monkeypatch.setattr(ranking_service, "aggregate_view_ranking", fake_view)
    monkeypatch.setattr(ranking_service, "get_fallback_ranking_movies", fake_fallback)

    for p in ("daily", "weekly", "monthly"):
        asyncio.run(ranking_service.get_ranking(None, period=p, limit=10))  # type: ignore[arg-type]

    assert seen_periods == ["daily", "weekly", "monthly"]


def test_get_ranking_uses_distinct_fallback_window_per_period(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """watch_count / view ともにゼロ時、daily/weekly/monthly で window_days が
    distinct な値で汎用フォールバックが呼ばれること。
    """
    seen_windows: list[int | None] = []

    async def fake_watch(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        return []

    async def fake_view(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        return []

    async def fake_fallback(db, *, limit, window_days, offset=0):  # type: ignore[no-untyped-def]
        seen_windows.append(window_days)
        return []

    monkeypatch.setattr(ranking_service, "aggregate_watch_count_ranking", fake_watch)
    monkeypatch.setattr(ranking_service, "aggregate_view_ranking", fake_view)
    monkeypatch.setattr(ranking_service, "get_fallback_ranking_movies", fake_fallback)

    for p in ("daily", "weekly", "monthly"):
        asyncio.run(ranking_service.get_ranking(None, period=p, limit=10))  # type: ignore[arg-type]

    assert seen_windows == [
        ranking_service._FALLBACK_WINDOW_DAYS["daily"],
        ranking_service._FALLBACK_WINDOW_DAYS["weekly"],
        ranking_service._FALLBACK_WINDOW_DAYS["monthly"],
    ]
    assert len(set(seen_windows)) == 3


def test_get_ranking_watch_count_is_primary_metric(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """watch_count 由来の作品がランキング先頭に並び、view 由来より優先されること。"""
    m_watch_1 = _movie(1, slug="movie-watch-1")
    m_watch_2 = _movie(2, slug="movie-watch-2")
    m_view_1 = _movie(3, slug="movie-view-1")
    m_view_2 = _movie(4, slug="movie-view-2")

    by_slug = {
        m_watch_1.slug: m_watch_1,
        m_watch_2.slug: m_watch_2,
        m_view_1.slug: m_view_1,
        m_view_2.slug: m_view_2,
    }

    async def fake_watch(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        # watch_count 上位 2 件
        return [(m_watch_1.slug, 10), (m_watch_2.slug, 5)]

    async def fake_view(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        # view イベント上位 2 件 (watch_count 由来の slug は含めない)
        return [(m_view_1.slug, 8), (m_view_2.slug, 4)]

    async def fake_get_by_slugs(db, slugs):  # type: ignore[no-untyped-def]
        return [by_slug[s] for s in slugs if s in by_slug]

    async def fake_fallback(db, *, limit, window_days, offset=0):  # type: ignore[no-untyped-def]
        return []

    monkeypatch.setattr(ranking_service, "aggregate_watch_count_ranking", fake_watch)
    monkeypatch.setattr(ranking_service, "aggregate_view_ranking", fake_view)
    monkeypatch.setattr(
        ranking_service, "get_movies_by_slugs_ordered", fake_get_by_slugs
    )
    monkeypatch.setattr(ranking_service, "get_fallback_ranking_movies", fake_fallback)

    out = asyncio.run(ranking_service.get_ranking(None, period="daily", limit=4))  # type: ignore[arg-type]
    # 並び順: watch_count 由来が先頭、その後に view 由来 (重複なし)。
    assert [c.slug for c in out] == [
        m_watch_1.slug,
        m_watch_2.slug,
        m_view_1.slug,
        m_view_2.slug,
    ]


def test_get_ranking_fills_short_watch_results_with_view_then_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """watch_count が不足 → view イベントで穴埋め → さらに不足したら汎用
    フォールバック、という 3 段の穴埋めが動くこと。
    """
    m_watch = _movie(1, slug="movie-watch")
    m_view = _movie(2, slug="movie-view")
    m_fallback = _movie(3, slug="movie-fallback")
    by_slug = {m_watch.slug: m_watch, m_view.slug: m_view}

    async def fake_watch(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        return [(m_watch.slug, 7)]

    async def fake_view(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        return [(m_view.slug, 3)]

    async def fake_get_by_slugs(db, slugs):  # type: ignore[no-untyped-def]
        return [by_slug[s] for s in slugs if s in by_slug]

    fallback_calls: list[dict] = []

    async def fake_fallback(db, *, limit, window_days, offset=0):  # type: ignore[no-untyped-def]
        fallback_calls.append(
            {"limit": limit, "window_days": window_days, "offset": offset}
        )
        return [m_fallback]

    monkeypatch.setattr(ranking_service, "aggregate_watch_count_ranking", fake_watch)
    monkeypatch.setattr(ranking_service, "aggregate_view_ranking", fake_view)
    monkeypatch.setattr(
        ranking_service, "get_movies_by_slugs_ordered", fake_get_by_slugs
    )
    monkeypatch.setattr(ranking_service, "get_fallback_ranking_movies", fake_fallback)

    out = asyncio.run(ranking_service.get_ranking(None, period="daily", limit=3))  # type: ignore[arg-type]

    assert len(fallback_calls) == 1
    assert fallback_calls[0]["window_days"] == ranking_service._FALLBACK_WINDOW_DAYS["daily"]
    # 並び順: watch → view → 汎用フォールバック
    assert [c.slug for c in out] == [m_watch.slug, m_view.slug, m_fallback.slug]


def test_get_ranking_skips_fallback_when_watch_satisfies_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """watch_count だけで limit を満たしていれば view / fallback を呼ばないこと。"""
    movies = [_movie(i) for i in range(5)]
    by_slug = {m.slug: m for m in movies}

    async def fake_watch(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        return [(m.slug, 10 - i) for i, m in enumerate(movies)]

    async def fake_get_by_slugs(db, slugs):  # type: ignore[no-untyped-def]
        return [by_slug[s] for s in slugs if s in by_slug]

    view_called = False
    fallback_called = False

    async def fake_view(db, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal view_called
        view_called = True
        return []

    async def fake_fallback(db, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal fallback_called
        fallback_called = True
        return []

    monkeypatch.setattr(ranking_service, "aggregate_watch_count_ranking", fake_watch)
    monkeypatch.setattr(ranking_service, "aggregate_view_ranking", fake_view)
    monkeypatch.setattr(
        ranking_service, "get_movies_by_slugs_ordered", fake_get_by_slugs
    )
    monkeypatch.setattr(ranking_service, "get_fallback_ranking_movies", fake_fallback)

    out = asyncio.run(ranking_service.get_ranking(None, period="weekly", limit=5))  # type: ignore[arg-type]

    assert len(out) == 5
    assert view_called is False
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
    """`get_popular_all_time` は watch_count (10秒到達) を主指標として使うこと。

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


def test_get_ranking_single_watch_beats_many_high_view_unwatched(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ユーザー報告シナリオの回帰テスト:

    1 件だけ watch_count > 0 の作品があり、view イベントは別の (未視聴の)
    作品が高数値で溜まっているとき、ランキング #1 は watch_count 由来で
    なければならない。

    旧 view 由来ランキングをそのまま流用したり、フォールバックが先頭に
    回ってしまうと、ユーザーから見て「全く視聴していない作品が #1」と
    いう挙動になる。それを防ぐリグレッション。
    """
    m_watch = _movie(1, slug="movie-watched-once")
    m_view_top1 = _movie(2, slug="movie-not-watched-top-views-1")
    m_view_top2 = _movie(3, slug="movie-not-watched-top-views-2")
    m_view_top3 = _movie(4, slug="movie-not-watched-top-views-3")
    by_slug = {
        m_watch.slug: m_watch,
        m_view_top1.slug: m_view_top1,
        m_view_top2.slug: m_view_top2,
        m_view_top3.slug: m_view_top3,
    }

    async def fake_watch(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        # たった 1 件のみ watch (count=1)
        return [(m_watch.slug, 1)]

    async def fake_view(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        # view は 3 件、いずれも 100/80/40 と高め
        return [
            (m_view_top1.slug, 100),
            (m_view_top2.slug, 80),
            (m_view_top3.slug, 40),
        ]

    async def fake_get_by_slugs(db, slugs):  # type: ignore[no-untyped-def]
        return [by_slug[s] for s in slugs if s in by_slug]

    async def fake_fallback(db, *, limit, window_days, offset=0):  # type: ignore[no-untyped-def]
        return []

    monkeypatch.setattr(ranking_service, "aggregate_watch_count_ranking", fake_watch)
    monkeypatch.setattr(ranking_service, "aggregate_view_ranking", fake_view)
    monkeypatch.setattr(
        ranking_service, "get_movies_by_slugs_ordered", fake_get_by_slugs
    )
    monkeypatch.setattr(ranking_service, "get_fallback_ranking_movies", fake_fallback)

    out = asyncio.run(ranking_service.get_ranking(None, period="daily", limit=4))  # type: ignore[arg-type]

    assert [c.slug for c in out] == [
        m_watch.slug,  # watch_count=1 が必ず #1
        m_view_top1.slug,  # 残り 3 件は view 由来 (未視聴)
        m_view_top2.slug,
        m_view_top3.slug,
    ]


def test_get_ranking_view_fallback_excludes_already_watched_slugs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """watch_count 由来として既に出した slug が、view イベント由来として
    同じランキングに再掲されないこと。

    現実には watch_count 上位は同時に view 上位でもあるので、重複除去を
    しないと「watch ランキングなのに同じ作品が複数位置に出る」「下位の
    順位が一段ずつ繰り下がる」ような違和感のある並びになる。
    """
    m_watch = _movie(1, slug="watch-and-view-overlap")
    m_view_only = _movie(2, slug="view-only")
    by_slug = {m_watch.slug: m_watch, m_view_only.slug: m_view_only}

    async def fake_watch(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        return [(m_watch.slug, 3)]

    async def fake_view(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        # 1 番目は watch_count に既出, 2 番目は view 限定
        return [(m_watch.slug, 50), (m_view_only.slug, 20)]

    async def fake_get_by_slugs(db, slugs):  # type: ignore[no-untyped-def]
        # 渡された slug 順を保つ
        return [by_slug[s] for s in slugs if s in by_slug]

    async def fake_fallback(db, *, limit, window_days, offset=0):  # type: ignore[no-untyped-def]
        return []

    monkeypatch.setattr(ranking_service, "aggregate_watch_count_ranking", fake_watch)
    monkeypatch.setattr(ranking_service, "aggregate_view_ranking", fake_view)
    monkeypatch.setattr(
        ranking_service, "get_movies_by_slugs_ordered", fake_get_by_slugs
    )
    monkeypatch.setattr(ranking_service, "get_fallback_ranking_movies", fake_fallback)

    out = asyncio.run(ranking_service.get_ranking(None, period="weekly", limit=5))  # type: ignore[arg-type]

    # m_watch は 1 度だけ #1 に出てくる。view 経路では除外される。
    assert [c.slug for c in out] == [m_watch.slug, m_view_only.slug]


def test_get_ranking_no_watch_data_falls_back_to_view(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """watch_count がまだ完全に貯まっていないときは view → 汎用フォールバック
    の順で穴埋めし、ランキングが空にならないこと。

    既存挙動の保持確認 (移行期に上位がスカスカにならないようにする)。
    """
    m_view = _movie(1, slug="view-1")
    m_fallback = _movie(2, slug="fallback-1")

    async def fake_watch(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        return []

    async def fake_view(db, *, period, limit, offset=0):  # type: ignore[no-untyped-def]
        return [(m_view.slug, 7)]

    async def fake_get_by_slugs(db, slugs):  # type: ignore[no-untyped-def]
        return [m_view] if m_view.slug in slugs else []

    async def fake_fallback(db, *, limit, window_days, offset=0):  # type: ignore[no-untyped-def]
        return [m_fallback]

    monkeypatch.setattr(ranking_service, "aggregate_watch_count_ranking", fake_watch)
    monkeypatch.setattr(ranking_service, "aggregate_view_ranking", fake_view)
    monkeypatch.setattr(
        ranking_service, "get_movies_by_slugs_ordered", fake_get_by_slugs
    )
    monkeypatch.setattr(ranking_service, "get_fallback_ranking_movies", fake_fallback)

    out = asyncio.run(ranking_service.get_ranking(None, period="daily", limit=3))  # type: ignore[arg-type]
    assert [c.slug for c in out] == [m_view.slug, m_fallback.slug]


def test_popular_all_time_single_watch_beats_many_high_view_unwatched(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ホーム "人気動画" セクションでもユーザー報告シナリオを担保する。

    1 件しか watch_count > 0 の作品が無くても、view 上位の未視聴作品が
    #1 に来ないこと (= canonical な watch_count 由来が必ず先頭)。
    """
    m_watch = _movie(1, slug="popular-watched-once")
    m_view1 = _movie(2, slug="popular-not-watched-view-1")
    m_view2 = _movie(3, slug="popular-not-watched-view-2")
    by_slug = {m_watch.slug: m_watch, m_view1.slug: m_view1, m_view2.slug: m_view2}

    async def fake_watch(db, *, limit, offset=0):  # type: ignore[no-untyped-def]
        return [(m_watch.slug, 1)]

    async def fake_view(db, *, limit, offset=0):  # type: ignore[no-untyped-def]
        return [(m_view1.slug, 999), (m_view2.slug, 500)]

    async def fake_get_by_slugs(db, slugs):  # type: ignore[no-untyped-def]
        return [by_slug[s] for s in slugs if s in by_slug]

    async def fake_fallback(db, *, limit, window_days, offset=0):  # type: ignore[no-untyped-def]
        return []

    monkeypatch.setattr(
        ranking_service, "aggregate_watch_count_ranking_all_time", fake_watch
    )
    monkeypatch.setattr(
        ranking_service, "aggregate_view_ranking_all_time", fake_view
    )
    monkeypatch.setattr(
        ranking_service, "get_movies_by_slugs_ordered", fake_get_by_slugs
    )
    monkeypatch.setattr(ranking_service, "get_fallback_ranking_movies", fake_fallback)

    out = asyncio.run(ranking_service.get_popular_all_time(None, limit=3))  # type: ignore[arg-type]
    assert [c.slug for c in out] == [m_watch.slug, m_view1.slug, m_view2.slug]


def test_popular_all_time_view_fallback_excludes_already_watched_slugs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """全期間人気でも、watch_count 由来の slug が view 由来として
    重複ランクインしないこと。
    """
    m_watch = _movie(1, slug="watched-and-popular")
    m_view = _movie(2, slug="view-only-popular")
    by_slug = {m_watch.slug: m_watch, m_view.slug: m_view}

    async def fake_watch(db, *, limit, offset=0):  # type: ignore[no-untyped-def]
        return [(m_watch.slug, 5)]

    async def fake_view(db, *, limit, offset=0):  # type: ignore[no-untyped-def]
        return [(m_watch.slug, 200), (m_view.slug, 50)]

    async def fake_get_by_slugs(db, slugs):  # type: ignore[no-untyped-def]
        return [by_slug[s] for s in slugs if s in by_slug]

    async def fake_fallback(db, *, limit, window_days, offset=0):  # type: ignore[no-untyped-def]
        return []

    monkeypatch.setattr(
        ranking_service, "aggregate_watch_count_ranking_all_time", fake_watch
    )
    monkeypatch.setattr(
        ranking_service, "aggregate_view_ranking_all_time", fake_view
    )
    monkeypatch.setattr(
        ranking_service, "get_movies_by_slugs_ordered", fake_get_by_slugs
    )
    monkeypatch.setattr(ranking_service, "get_fallback_ranking_movies", fake_fallback)

    out = asyncio.run(ranking_service.get_popular_all_time(None, limit=5))  # type: ignore[arg-type]
    assert [c.slug for c in out] == [m_watch.slug, m_view.slug]


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
