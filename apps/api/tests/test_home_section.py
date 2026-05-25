"""/api/v1/home/section の契約テスト。

サービス層 (`get_popular_all_time`, `get_ranking`, リポジトリ層) を monkeypatch で
差し替えて、エンドポイントが offset / limit を SQL レベルで使って正しくページネーション
できること、key='genre' の引数バリデーション、未知 key の 400 を確認する。

サーバは limit+1 件取って次ページ判定するため、モックは offset/limit に応じて
任意件数返せるようにしている。
"""
from __future__ import annotations

from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from app.api.v1.endpoints import home as home_endpoint
from app.main import app
from app.schemas.movie import MovieCard, PriceList


def _card(i: int) -> MovieCard:
    return MovieCard(
        id=f"00000000-0000-0000-0000-{i:012d}",
        content_id=f"abc{i:05d}",
        title=f"テスト作品 {i:03d}",
        slug=f"test-movie-{i:03d}",
        image_url_list=None,
        image_url_large=None,
        affiliate_url=f"https://www.dmm.co.jp/digital/videoa/-/detail/=/cid=abc{i:05d}/?af_id=test-990",
        price_list=PriceList(list_price=1980, sale_price=980),
        price_min=980,
        review_count=0,
        review_average=None,
        actresses=[],
        genres=[],
        series_name=None,
    )


def _make_movie(i: int):
    """get_movies_by_genre / get_new_release_movies / get_recent_release_movies が
    返す Movie ORM の代わりに、_to_card で MovieCard に変換できる軽量オブジェクトを返す。
    _to_card は属性アクセスなのでダックタイピングで十分。
    """
    card = _card(i)

    class _M:
        id = card.id
        content_id = card.content_id
        title = card.title
        slug = card.slug
        image_url_list = card.image_url_list
        image_url_large = card.image_url_large
        affiliate_url = card.affiliate_url
        price_list = None
        price_min = card.price_min
        review_count = card.review_count
        review_average = card.review_average
        actresses: list = []
        genres: list = []
        series = None
        series_name = None

    return _M()


def _paged_cards(total: int, offset: int, limit: int) -> list[MovieCard]:
    """全 total 件のうち [offset, offset+limit) のスライスを返す。"""
    start = max(0, offset)
    end = min(total, offset + limit)
    if start >= end:
        return []
    return [_card(i) for i in range(start, end)]


def _paged_movies(total: int, offset: int, limit: int):
    start = max(0, offset)
    end = min(total, offset + limit)
    if start >= end:
        return []
    return [_make_movie(i) for i in range(start, end)]


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    # 各セクションの "想定全件" は固定値。SQL OFFSET/LIMIT 相当の振る舞いをモック。
    POPULAR_TOTAL = 100
    RANKING_TOTAL = 100
    NEW_TOTAL = 5
    RECENT_TOTAL = 40
    GENRE_TOTAL = 50

    async def fake_get_popular_all_time(db, limit, offset=0):  # type: ignore[no-untyped-def]
        return _paged_cards(POPULAR_TOTAL, offset, limit)

    async def fake_get_ranking(db, period, limit, offset=0):  # type: ignore[no-untyped-def]
        return _paged_cards(RANKING_TOTAL, offset, limit)

    async def fake_get_new_release_movies(db, limit, fallback_days, offset=0):  # type: ignore[no-untyped-def]
        return _paged_movies(NEW_TOTAL, offset, limit)

    async def fake_get_recent_release_movies(db, days, limit, offset=0):  # type: ignore[no-untyped-def]
        return _paged_movies(RECENT_TOTAL, offset, limit)

    async def fake_get_movies_by_genre(db, genre_name, limit, offset=0):  # type: ignore[no-untyped-def]
        return _paged_movies(GENRE_TOTAL, offset, limit)

    monkeypatch.setattr(home_endpoint, "get_popular_all_time", fake_get_popular_all_time)
    monkeypatch.setattr(home_endpoint, "get_ranking", fake_get_ranking)
    monkeypatch.setattr(home_endpoint, "get_new_release_movies", fake_get_new_release_movies)
    monkeypatch.setattr(home_endpoint, "get_recent_release_movies", fake_get_recent_release_movies)
    monkeypatch.setattr(home_endpoint, "get_movies_by_genre", fake_get_movies_by_genre)

    yield TestClient(app)


def test_section_popular_first_page(client: TestClient) -> None:
    res = client.get("/api/v1/home/section", params={"key": "popular", "offset": 0, "limit": 20})
    assert res.status_code == 200
    data = res.json()
    assert len(data["items"]) == 20
    # 100 件あるので次がある
    assert data["next_cursor"] == "20"


def test_section_ranking_daily_paginated(client: TestClient) -> None:
    res = client.get(
        "/api/v1/home/section",
        params={"key": "ranking_daily", "offset": 40, "limit": 20},
    )
    assert res.status_code == 200
    data = res.json()
    assert len(data["items"]) == 20
    assert data["next_cursor"] == "60"


def test_section_last_page_has_no_next_cursor(client: TestClient) -> None:
    # new は 5 件しかないので 1 ページ目で next_cursor=None
    res = client.get("/api/v1/home/section", params={"key": "new", "offset": 0, "limit": 20})
    assert res.status_code == 200
    data = res.json()
    assert len(data["items"]) == 5
    assert data["next_cursor"] is None


def test_section_genre_requires_genre_param(client: TestClient) -> None:
    res = client.get("/api/v1/home/section", params={"key": "genre"})
    assert res.status_code == 400


def test_section_genre_with_param_ok(client: TestClient) -> None:
    res = client.get(
        "/api/v1/home/section",
        params={"key": "genre", "genre": "テスト", "offset": 0, "limit": 20},
    )
    assert res.status_code == 200
    data = res.json()
    assert len(data["items"]) == 20
    assert data["next_cursor"] == "20"


def test_section_unknown_key_400(client: TestClient) -> None:
    res = client.get("/api/v1/home/section", params={"key": "unknown_key"})
    assert res.status_code == 400


def test_section_ranking_paginates_past_100(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ランキングが offset 100 を越えても「もっと見る」で進めること。

    以前は fetch_size=max(offset+limit, 100) だったため 100 件目以降を取れない
    バグがあった。今は SQL OFFSET でちゃんと指定区間が取れる。
    """

    async def big_ranking(db, period, limit, offset=0):  # type: ignore[no-untyped-def]
        return _paged_cards(200, offset, limit)

    monkeypatch.setattr(home_endpoint, "get_ranking", big_ranking)

    client = TestClient(app)
    res = client.get(
        "/api/v1/home/section",
        params={"key": "ranking_daily", "offset": 100, "limit": 20},
    )
    assert res.status_code == 200
    data = res.json()
    assert len(data["items"]) == 20  # 101 〜 120 件目
    assert data["next_cursor"] == "120"  # まだ続く


def test_section_lookahead_decides_next_cursor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """サーバは limit+1 件取って "次ページがあるか" を判定する。

    全 21 件のセクションで limit=20 を要求 → 21 件取れる → 次ありと判定。
    全 20 件のセクションで limit=20 を要求 → 20 件しか取れない → 末尾。
    """

    async def total_21(db, limit, offset=0):  # type: ignore[no-untyped-def]
        return _paged_cards(21, offset, limit)

    async def total_20(db, limit, offset=0):  # type: ignore[no-untyped-def]
        return _paged_cards(20, offset, limit)

    # 全 21 件: 次あり
    monkeypatch.setattr(home_endpoint, "get_popular_all_time", total_21)
    client = TestClient(app)
    res = client.get(
        "/api/v1/home/section", params={"key": "popular", "offset": 0, "limit": 20}
    )
    assert res.status_code == 200
    data = res.json()
    assert len(data["items"]) == 20
    assert data["next_cursor"] == "20"

    # 次ページに進むと 1 件だけ残っているが、その先はないので next_cursor=None
    res2 = client.get(
        "/api/v1/home/section", params={"key": "popular", "offset": 20, "limit": 20}
    )
    assert res2.status_code == 200
    data2 = res2.json()
    assert len(data2["items"]) == 1
    assert data2["next_cursor"] is None

    # 全 20 件: 末尾扱い
    monkeypatch.setattr(home_endpoint, "get_popular_all_time", total_20)
    res3 = client.get(
        "/api/v1/home/section", params={"key": "popular", "offset": 0, "limit": 20}
    )
    assert res3.status_code == 200
    data3 = res3.json()
    assert len(data3["items"]) == 20
    assert data3["next_cursor"] is None


def test_section_passes_offset_to_service(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """エンドポイントが offset/limit+1 をそのままサービス層に渡していること。

    リポジトリ層が SQL OFFSET/LIMIT で実装される前提なので、エンドポイントから
    SQL に渡すパラメータが offset と limit+1 になっている必要がある。
    """
    received: dict = {}

    async def spying_ranking(db, period, limit, offset=0):  # type: ignore[no-untyped-def]
        received["period"] = period
        received["limit"] = limit
        received["offset"] = offset
        return _paged_cards(500, offset, limit)

    monkeypatch.setattr(home_endpoint, "get_ranking", spying_ranking)

    client = TestClient(app)
    client.get(
        "/api/v1/home/section",
        params={"key": "ranking_weekly", "offset": 42, "limit": 21},
    )
    assert received == {"period": "weekly", "limit": 22, "offset": 42}


def test_home_sections_order_and_titles(client: TestClient) -> None:
    """/api/v1/home がユーザー要望の順番とタイトルでセクションを返すこと。"""
    # ジャンル系はモック差し替えしていないため、それらに依存せずに上位 6 セクションだけ確認する。
    # ただし popular_search_genres / top_genres_by_movie_count はモック未差し替えだと DB を叩いて
    # 落ちるのでここではモックして空を返す。
    from app.services import ranking_service
    from app.repositories import movie_repository

    async def empty_genres(*args, **kwargs):  # type: ignore[no-untyped-def]
        return []

    # monkeypatch する場所が conftest と分かれるので、TestClient 内で直接 import 経由で差し替え
    import app.api.v1.endpoints.home as h
    h.get_popular_search_genres = empty_genres  # type: ignore[assignment]
    h.get_top_genres_by_movie_count = empty_genres  # type: ignore[assignment]
    # ranking_service, movie_repository 側も念のため参照
    ranking_service.get_popular_search_genres = empty_genres  # type: ignore[assignment]
    movie_repository.get_top_genres_by_movie_count = empty_genres  # type: ignore[assignment]

    res = client.get("/api/v1/home", params={"section_limit": 20})
    assert res.status_code == 200
    data = res.json()
    sections = data["sections"]

    # 必要な並び順: new, recent, popular, ranking_daily, ranking_weekly, ranking_monthly, ...
    keys = [s["key"] for s in sections]
    assert keys[:6] == [
        "new",
        "recent",
        "popular",
        "ranking_daily",
        "ranking_weekly",
        "ranking_monthly",
    ]
    titles = {s["key"]: s["title"] for s in sections}
    # 「デイリーランキング」ではなく「日間ランキング」になっていること
    assert titles["ranking_daily"] == "日間ランキング"
    assert titles["ranking_weekly"] == "週間ランキング"
    assert titles["ranking_monthly"] == "月間ランキング"
