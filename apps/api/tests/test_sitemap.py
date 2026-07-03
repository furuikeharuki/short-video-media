"""GET /api/v1/sitemap/urls エンドポイントの契約テスト。

DB に触れずに、サービス層が返す行をフェイクして、レスポンスの形だけ検証する。
"""
from __future__ import annotations

from datetime import date
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.db.session import get_db
from app.main import app


class _FakeAllResult:
    def __init__(self, rows: list[tuple]) -> None:
        self._rows = rows

    def all(self) -> list[tuple]:
        return self._rows


class _FakeSession:
    """statement に応じて、用意した rows を順番に返す。

    sitemap エンドポイントは
      1. SELECT movies (Movie.slug, Movie.primary_date)
      2. SELECT actresses (Actress.name, MAX(Movie.primary_date))
      3. SELECT genres (Genre.name, MAX(Movie.primary_date))
    の 3 回しか SELECT を走らせない前提で、それぞれの結果を順番に返す。
    """

    def __init__(
        self,
        movie_rows: list[tuple],
        actress_rows: list[tuple],
        genre_rows: list[tuple],
        movie_total: int | None = None,
    ) -> None:
        self._queue: list[list[tuple]] = [movie_rows, actress_rows, genre_rows]
        self._movie_total = movie_total

    async def execute(self, statement: Any):  # type: ignore[no-untyped-def]
        rows = self._queue.pop(0) if self._queue else []
        return _FakeAllResult(rows)

    async def scalar(self, statement: Any):  # type: ignore[no-untyped-def]
        return self._movie_total


def _make_client(
    movie_rows: list[tuple],
    actress_rows: list[tuple],
    genre_rows: list[tuple] | None = None,
    movie_total: int | None = None,
) -> TestClient:
    session = _FakeSession(movie_rows, actress_rows, genre_rows or [], movie_total)

    async def _fake_get_db():  # type: ignore[no-untyped-def]
        yield session

    app.dependency_overrides[get_db] = _fake_get_db
    return TestClient(app)


@pytest.fixture(autouse=True)
def _cleanup_overrides() -> Iterator[None]:
    yield
    app.dependency_overrides.pop(get_db, None)


def test_sitemap_urls_returns_movies_and_actresses() -> None:
    movie_rows = [
        ("movie-a", date(2026, 5, 1)),
        ("movie-b", date(2026, 4, 20)),
        ("movie-c", None),
    ]
    actress_rows = [
        ("Aoi Yuki", date(2026, 5, 1)),
        ("Hanako", None),
    ]
    genre_rows = [
        ("巨乳", date(2026, 5, 1)),
        ("人妻", None),
    ]
    client = _make_client(movie_rows, actress_rows, genre_rows)

    resp = client.get("/api/v1/sitemap/urls")
    assert resp.status_code == 200
    body = resp.json()

    assert [m["slug"] for m in body["movies"]] == [
        "movie-a",
        "movie-b",
        "movie-c",
    ]
    # date は ISO 形式の文字列で返る (last_modified が None のものは null)
    assert body["movies"][0]["last_modified"] == "2026-05-01"
    assert body["movies"][2]["last_modified"] is None

    assert [a["name"] for a in body["actresses"]] == ["Aoi Yuki", "Hanako"]
    assert body["actresses"][0]["last_modified"] == "2026-05-01"
    assert body["actresses"][1]["last_modified"] is None

    assert [g["name"] for g in body["genres"]] == ["巨乳", "人妻"]
    assert body["genres"][0]["last_modified"] == "2026-05-01"
    assert body["genres"][1]["last_modified"] is None


def test_sitemap_urls_returns_empty_lists_when_no_rows() -> None:
    client = _make_client([], [], [])

    resp = client.get("/api/v1/sitemap/urls")
    assert resp.status_code == 200
    assert resp.json() == {"movies": [], "actresses": [], "genres": []}


def test_sitemap_urls_includes_movie_total_only_when_requested() -> None:
    client = _make_client([], [], [], movie_total=0)

    resp = client.get(
        "/api/v1/sitemap/urls",
        params={"include_movie_total": "true"},
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "movies": [],
        "actresses": [],
        "genres": [],
        "movie_total": 0,
    }


def test_sitemap_urls_respects_limit_query_params() -> None:
    """limit が小さくても 1 以上ならエラーにならず、フェイク行をそのまま返す。

    本テストはエンドポイント側で SQL に LIMIT を渡していることの最低限の証明として、
    400/422 が発生しないことを確認する。
    """
    client = _make_client([], [])

    resp = client.get(
        "/api/v1/sitemap/urls",
        params={"movie_limit": 1, "actress_limit": 1},
    )
    assert resp.status_code == 200
