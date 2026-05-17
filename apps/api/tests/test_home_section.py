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


def test_section_ranking_paginates_past_100(client: TestClient) -> None:
    """ランキングが 100 件で門ちされず、100 件を越えても「もっと見る」で進めること。

    以前は fetch_size=max(offset+limit, 100) だったため、ランキングが例えサーバで
    1000 件あっても 100 件目以降を取れなかった。
    このテストではモックを 200 件返すようにして、offset=100 でも
    次ページが返ることを確認する。
    """
    import app.api.v1.endpoints.home as h

    async def big_ranking(db, period, limit):  # type: ignore[no-untyped-def]
        return [_card(i) for i in range(min(limit, 200))]

    h.get_ranking = big_ranking  # type: ignore[assignment]

    # offset=100 = "もっと見る" で 100 件目を越えたところ。
    res = client.get(
        "/api/v1/home/section",
        params={"key": "ranking_daily", "offset": 100, "limit": 20},
    )
    assert res.status_code == 200
    data = res.json()
    assert len(data["items"]) == 20  # 101 〜 120 件目
    assert data["next_cursor"] == "120"  # まだ続く


def test_section_returns_full_limit_when_visible_filter_drops_some(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """リポジトリ層の visible filter で間引かれても、要求 limit 件をきっちり返す。

    実環境では `get_movies_by_slugs_ordered` などが `Movie.is_visible.is_(True)` で
    間引くため、limit=21 を要求しても 20 件しか返ってこないことがある。
    その場合 3 列グリッドでは 20 件 = 6 行 + 端数 1 となり、次バッチの 21 件と
    あわせると 41 件 → 列がずれる。
    エンドポイント側で余裕をもって fetch_size を取り、サービス層が十分件数を
    持っていれば limit 件ぴったり返すように修正したことを担保するテスト。
    """
    # service 層は limit ぶん要求されても "15% 間引いた" 件数しか返さないシミュレーション
    async def lossy_popular(db, limit):  # type: ignore[no-untyped-def]
        # たくさんある中で is_visible=True なのは 200 件、と仮定。
        # ただし 1 件あたり 15% は visible=False で落ちるので、結果的に
        # 「要求件数の 85%」しか返ってこないケースを再現。
        kept = int(min(limit, 200) * 0.85)
        return [_card(i) for i in range(kept)]

    monkeypatch.setattr(home_endpoint, "get_popular_all_time", lossy_popular)

    client = TestClient(app)
    res = client.get(
        "/api/v1/home/section", params={"key": "popular", "offset": 0, "limit": 21}
    )
    assert res.status_code == 200
    data = res.json()
    # fetch_size = max(0 + 21*2, 0 + 21 + 10) = 42 → 0.85*42 = 35 件取得 → 先頭 21 件返却
    assert len(data["items"]) == 21
    # 35 >= 21 なので次ページがあると判定される
    assert data["next_cursor"] == "21"


def test_section_returns_none_when_truly_at_end(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """サービス層が limit 未満しか返さないとき (本当に末尾) は next_cursor=None。"""
    async def small_popular(db, limit):  # type: ignore[no-untyped-def]
        # 全部で 10 件しかない
        return [_card(i) for i in range(min(limit, 10))]

    monkeypatch.setattr(home_endpoint, "get_popular_all_time", small_popular)

    client = TestClient(app)
    res = client.get(
        "/api/v1/home/section", params={"key": "popular", "offset": 0, "limit": 21}
    )
    assert res.status_code == 200
    data = res.json()
    assert len(data["items"]) == 10
    assert data["next_cursor"] is None


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
