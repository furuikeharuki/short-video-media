"""/api/v1/search の詳細絞り込みテスト。

DB に実接続せず、リポジトリ層 (`advanced_search_movies` / `search_movies`) と
`get_optional_user` 依存を差し替えて、エンドポイントが受け取ったクエリパラメータを
正しくリポジトリへ渡すか、サーバ保存の NG ワードを未指定時にロードするかを確認する。

他のテストファイル (test_home_section.py) と同じ monkeypatch + FastAPI
dependency_overrides の組み合わせ。
"""
from __future__ import annotations

from datetime import date
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.api.v1.endpoints import search as search_endpoint
from app.core.security import get_optional_user
from app.db.session import get_db
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
        affiliate_url=f"https://example.com/{i}",
        price_list=PriceList(list_price=1980, sale_price=980),
        price_min=980,
        review_count=0,
        review_average=None,
        actresses=[],
        genres=[],
        series_name=None,
    )


def _make_movie(i: int):
    """advanced_search_movies が返す Movie ORM の代替ダミー。

    _to_card は属性アクセスのみなのでダックタイピングで十分。
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


class _FakeDB:
    """`db.execute(select(UserNgWord.word)...)` をハンドリングするための最小スタブ。

    エンドポイント側はサーバ保存 NG ワードを取りに来た時だけ DB を叩く。
    そこで返す words を fixture から差し込めるようにしている。
    """

    def __init__(self, ng_words_for_user: list[str]) -> None:
        self._ng_words = ng_words_for_user

    async def execute(self, _stmt):  # noqa: ANN001
        ng_words = self._ng_words

        class _Result:
            def all(self_inner):  # noqa: ANN001
                return [(w,) for w in ng_words]

        return _Result()


@pytest.fixture
def captured() -> dict[str, Any]:
    return {}


@pytest.fixture
def client(
    monkeypatch: pytest.MonkeyPatch, captured: dict[str, Any]
) -> Iterator[TestClient]:
    async def fake_advanced(db, **kwargs):  # type: ignore[no-untyped-def]
        # 渡された全パラメータを残しておき、アサーションで読む
        captured["advanced"] = kwargs
        movies = [_make_movie(i) for i in range(3)]
        return movies, 3

    async def fake_simple(db, query, *, limit, offset):  # type: ignore[no-untyped-def]
        captured["simple"] = {"query": query, "limit": limit, "offset": offset}
        movies = [_make_movie(i) for i in range(2)]
        return movies, 2

    # search_repository から import された名前を差し替える (service が直接参照)
    from app.services import search_service as ss

    monkeypatch.setattr(ss, "advanced_search_movies", fake_advanced)
    monkeypatch.setattr(ss, "search_movies", fake_simple)

    # 未ログイン (デフォルト) と、ログイン + サーバ NG ワード のテストを切替えるため
    # fixture では未ログインをデフォルトにする (個別テストで override する)。
    async def _no_user():
        return None

    async def _fake_db():
        yield _FakeDB([])

    app.dependency_overrides[get_optional_user] = _no_user
    app.dependency_overrides[get_db] = _fake_db

    yield TestClient(app)

    app.dependency_overrides.clear()


# ---------------- 後方互換 ----------------


def test_q_only_uses_simple_search(client: TestClient, captured: dict[str, Any]) -> None:
    """q だけ指定された場合は従来の `search_movies` (シンプル検索) が呼ばれる。"""
    res = client.get("/api/v1/search", params={"q": "テスト"})
    assert res.status_code == 200
    assert "simple" in captured
    assert captured["simple"]["query"] == "テスト"
    assert "advanced" not in captured


def test_missing_all_returns_400(client: TestClient) -> None:
    res = client.get("/api/v1/search")
    assert res.status_code == 400


# ---------------- 新しい絞り込み ----------------


def test_genres_and_actresses_passed_as_lists(
    client: TestClient, captured: dict[str, Any]
) -> None:
    res = client.get(
        "/api/v1/search",
        params=[
            ("genres", "AAA"),
            ("genres", "BBB"),
            ("actresses", "X"),
            ("actresses", "Y"),
        ],
    )
    assert res.status_code == 200
    kw = captured["advanced"]
    assert kw["genres"] == ["AAA", "BBB"]
    assert kw["actresses"] == ["X", "Y"]


def test_date_range_passed_through(
    client: TestClient, captured: dict[str, Any]
) -> None:
    res = client.get(
        "/api/v1/search",
        params={"date_from": "2025-01-01", "date_to": "2025-12-31"},
    )
    assert res.status_code == 200
    kw = captured["advanced"]
    assert kw["date_from"] == date(2025, 1, 1)
    assert kw["date_to"] == date(2025, 12, 31)


@pytest.mark.parametrize("sort", ["new", "popular", "rating", "views", "bookmarks"])
def test_sort_passes_through(
    monkeypatch: pytest.MonkeyPatch,
    captured: dict[str, Any],
    sort: str,
) -> None:
    """5 種類のソートキーがそれぞれ repo まで渡る (sort=new は genres 等の他パラメータと一緒の時のみ advanced を起動)。"""

    async def fake_advanced(db, **kwargs):  # type: ignore[no-untyped-def]
        captured["advanced"] = kwargs
        return [], 0

    async def fake_simple(db, query, *, limit, offset):  # type: ignore[no-untyped-def]
        captured["simple"] = {"query": query}
        return [], 0

    from app.services import search_service as ss

    monkeypatch.setattr(ss, "advanced_search_movies", fake_advanced)
    monkeypatch.setattr(ss, "search_movies", fake_simple)

    async def _no_user():
        return None

    async def _fake_db():
        yield _FakeDB([])

    app.dependency_overrides[get_optional_user] = _no_user
    app.dependency_overrides[get_db] = _fake_db

    try:
        # sort=new は単独だと simple ルートに落ちるので、genres を 1 つ添えて
        # advanced ルートを必ず通るようにする
        res = TestClient(app).get(
            "/api/v1/search", params=[("sort", sort), ("genres", "Z")]
        )
        assert res.status_code == 200
        assert captured["advanced"]["sort"] == sort
    finally:
        app.dependency_overrides.clear()


def test_ng_words_from_query_used_when_specified(
    client: TestClient, captured: dict[str, Any]
) -> None:
    res = client.get(
        "/api/v1/search",
        params=[("ng_words", "アイドル"), ("ng_words", "巨乳")],
    )
    assert res.status_code == 200
    assert captured["advanced"]["ng_words"] == ["アイドル", "巨乳"]


def test_unauth_no_ng_words_means_empty(
    client: TestClient, captured: dict[str, Any]
) -> None:
    """未ログインで ng_words クエリ未指定なら NG なし (empty list)。"""
    res = client.get("/api/v1/search", params={"genres": "Z"})
    assert res.status_code == 200
    assert captured["advanced"]["ng_words"] == []


def test_logged_in_uses_stored_ng_words_when_query_empty(
    monkeypatch: pytest.MonkeyPatch, captured: dict[str, Any]
) -> None:
    """ログイン中 & ng_words クエリ未指定 → DB の NG ワードが使われる。"""

    async def fake_advanced(db, **kwargs):  # type: ignore[no-untyped-def]
        captured["advanced"] = kwargs
        return [], 0

    from app.services import search_service as ss

    monkeypatch.setattr(ss, "advanced_search_movies", fake_advanced)

    # ダミーの user オブジェクト (.id だけあれば OK)
    class _U:
        id = "user-1"

    async def _user():
        return _U()

    async def _fake_db():
        yield _FakeDB(["DB-NG-1", "DB-NG-2"])

    app.dependency_overrides[get_optional_user] = _user
    app.dependency_overrides[get_db] = _fake_db
    try:
        res = TestClient(app).get("/api/v1/search", params={"genres": "Z"})
        assert res.status_code == 200
        assert captured["advanced"]["ng_words"] == ["DB-NG-1", "DB-NG-2"]
    finally:
        app.dependency_overrides.clear()


def test_logged_in_query_ng_words_override_db(
    monkeypatch: pytest.MonkeyPatch, captured: dict[str, Any]
) -> None:
    """クエリ ng_words が指定されている時は DB を読まずクエリを優先する。"""

    async def fake_advanced(db, **kwargs):  # type: ignore[no-untyped-def]
        captured["advanced"] = kwargs
        return [], 0

    from app.services import search_service as ss

    monkeypatch.setattr(ss, "advanced_search_movies", fake_advanced)

    class _U:
        id = "user-1"

    async def _user():
        return _U()

    async def _fake_db():
        yield _FakeDB(["DB-NG-1"])

    app.dependency_overrides[get_optional_user] = _user
    app.dependency_overrides[get_db] = _fake_db
    try:
        res = TestClient(app).get(
            "/api/v1/search", params=[("ng_words", "Q-NG"), ("genres", "Z")]
        )
        assert res.status_code == 200
        assert captured["advanced"]["ng_words"] == ["Q-NG"]
    finally:
        app.dependency_overrides.clear()


def test_legacy_single_exact_fields_still_supported(
    monkeypatch: pytest.MonkeyPatch, captured: dict[str, Any]
) -> None:
    """旧 single パラメータ (director=...) は advanced を起動しなければ search_movies_by_exact_field を呼ぶ。"""

    async def fake_exact(db, **kwargs):  # type: ignore[no-untyped-def]
        captured["exact"] = kwargs
        return [_make_movie(0)], 1

    from app.services import search_service as ss

    monkeypatch.setattr(ss, "search_movies_by_exact_field", fake_exact)

    async def _no_user():
        return None

    async def _fake_db():
        yield _FakeDB([])

    app.dependency_overrides[get_optional_user] = _no_user
    app.dependency_overrides[get_db] = _fake_db
    try:
        res = TestClient(app).get("/api/v1/search", params={"director": "監督A"})
        assert res.status_code == 200
        assert captured["exact"]["director"] == "監督A"
    finally:
        app.dependency_overrides.clear()


# ---------------- /search/suggest ----------------


@pytest.fixture
def suggest_client(
    monkeypatch: pytest.MonkeyPatch, captured: dict[str, Any]
) -> Iterator[TestClient]:
    """suggest_field_values をモックして field / q / limit が渡ることを確認するクライアント。"""

    async def fake_suggest(db, *, field, q, limit):  # type: ignore[no-untyped-def]
        captured["suggest"] = {"field": field, "q": q, "limit": limit}
        # ダミーで件数の多い順を模した文字列リストを返す
        return [f"{field}-1", f"{field}-2", f"{field}-3"][:limit]

    # エンドポイントは search_repository から直接 import しているため、
    # endpoint モジュール側の参照 (app.api.v1.endpoints.search.suggest_field_values) を差し替える。
    monkeypatch.setattr(search_endpoint, "suggest_field_values", fake_suggest)

    async def _fake_db():
        yield _FakeDB([])

    app.dependency_overrides[get_db] = _fake_db
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.mark.parametrize(
    "field", ["actress", "series", "director", "maker", "label", "genre"]
)
def test_suggest_field_passes_through(
    suggest_client: TestClient, captured: dict[str, Any], field: str
) -> None:
    """6 フィールドそれぞれが repo まで届き、items が返ること。"""
    res = suggest_client.get(
        "/api/v1/search/suggest",
        params={"field": field, "q": "テス", "limit": 5},
    )
    assert res.status_code == 200
    body = res.json()
    assert "items" in body
    assert body["items"] == [f"{field}-1", f"{field}-2", f"{field}-3"]
    assert captured["suggest"] == {"field": field, "q": "テス", "limit": 5}


def test_suggest_default_q_and_limit(
    suggest_client: TestClient, captured: dict[str, Any]
) -> None:
    """q 未指定なら空文字、limit 未指定なら 10 が repo に渡る。"""
    res = suggest_client.get("/api/v1/search/suggest", params={"field": "genre"})
    assert res.status_code == 200
    assert captured["suggest"] == {"field": "genre", "q": "", "limit": 10}


def test_suggest_rejects_unknown_field(suggest_client: TestClient) -> None:
    """Literal バリデーションで知らない field は 422 になる。"""
    res = suggest_client.get(
        "/api/v1/search/suggest", params={"field": "unknown_field"}
    )
    assert res.status_code == 422


def test_suggest_limit_out_of_range(suggest_client: TestClient) -> None:
    """limit のレンジ外 (>50) は 422。"""
    res = suggest_client.get(
        "/api/v1/search/suggest", params={"field": "genre", "limit": 100}
    )
    assert res.status_code == 422
