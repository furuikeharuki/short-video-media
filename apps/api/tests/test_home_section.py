"""/api/v1/home/section の契約テスト。

サービス層 (`get_popular_all_time`, `get_ranking`, リポジトリ層) を monkeypatch で
差し替えて、エンドポイントが offset / limit を正しくサーバ側スライスして返すこと、
key='genre' の引数バリデーション、未知 key の 400 を確認する。
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
        sample_movie_url=None,
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
        sample_movie_url = card.sample_movie_url
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


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    # ランキング / 人気は MovieCard を直接返す API なのでそのまま 100 件返す
    async def fake_get_popular_all_time(db, limit):  # type: ignore[no-untyped-def]
        return [_card(i) for i in range(min(limit, 100))]

    async def fake_get_ranking(db, period, limit):  # type: ignore[no-untyped-def]
        return [_card(i) for i in range(min(limit, 100))]

    async def fake_get_new_release_movies(db, limit, fallback_days):  # type: ignore[no-untyped-def]
        return [_make_movie(i) for i in range(min(limit, 5))]

    async def fake_get_recent_release_movies(db, days, limit):  # type: ignore[no-untyped-def]
        return [_make_movie(i) for i in range(min(limit, 40))]

    async def fake_get_movies_by_genre(db, genre_name, limit):  # type: ignore[no-untyped-def]
        return [_make_movie(i) for i in range(min(limit, 50))]

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
