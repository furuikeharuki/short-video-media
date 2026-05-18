"""DELETE /movies/{slug}/sample-url エンドポイントのテスト。

クライアントから「この URL は再生失敗した」という報告を受けて、
DB の sample_movie_url を NULL に戻すエンドポイント。
"""
from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.db.session import get_db
from app.main import app


class _FakeRowResult:
    def __init__(self, row: tuple | None) -> None:
        self._row = row

    def first(self) -> tuple | None:
        return self._row


class _FakeUpdateResult:
    rowcount = 1


class _FakeSession:
    """SELECT は最初に渡された row を返し、UPDATE は記録するだけ。"""

    def __init__(self, row: tuple | None) -> None:
        self._row = row
        self.update_calls: list[Any] = []
        self.committed = False

    async def execute(self, statement: Any):  # type: ignore[no-untyped-def]
        compiled = str(statement).strip().upper()
        if compiled.startswith("SELECT"):
            return _FakeRowResult(self._row)
        # UPDATE 系
        self.update_calls.append(statement)
        return _FakeUpdateResult()

    async def commit(self) -> None:
        self.committed = True


def _make_client(row: tuple | None) -> tuple[TestClient, _FakeSession]:
    session = _FakeSession(row)

    async def _fake_get_db():  # type: ignore[no-untyped-def]
        yield session

    app.dependency_overrides[get_db] = _fake_get_db
    return TestClient(app), session


@pytest.fixture(autouse=True)
def _cleanup_overrides() -> Iterator[None]:
    yield
    app.dependency_overrides.pop(get_db, None)


# ─────────────────────────────────────────────
# テスト本体
# ─────────────────────────────────────────────
def test_invalidate_sample_url_returns_204_and_updates_db() -> None:
    """sample_movie_url が入っていれば UPDATE が走って 204 を返す。"""
    row = ("movie-uuid",)
    client, session = _make_client(row)

    resp = client.delete("/api/v1/movies/some-slug/sample-url")
    assert resp.status_code == 204
    assert resp.content == b""
    # UPDATE が 1 回走り commit されている
    assert len(session.update_calls) == 1
    assert session.committed is True


def test_invalidate_sample_url_returns_204_even_when_already_null() -> None:
    """sample_movie_url がもとから NULL のときも 204 (重複呼び出し許容)。

    UPDATE の WHERE 句で is_not(None) を指定しているため、実際の rowcount は 0 だが
    クライアント側からは正常終了扱いで OK。
    """
    row = ("movie-uuid",)
    client, session = _make_client(row)

    resp = client.delete("/api/v1/movies/some-slug/sample-url")
    assert resp.status_code == 204
    # UPDATE 自体は発行される (DB 側が WHERE で空打ちを判断)
    assert len(session.update_calls) == 1


def test_invalidate_sample_url_returns_404_for_unknown_slug() -> None:
    """対象作品が存在しなければ 404。"""
    client, session = _make_client(None)

    resp = client.delete("/api/v1/movies/does-not-exist/sample-url")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Movie not found"
    # 404 のときは UPDATE も commit も走らない
    assert session.update_calls == []
    assert session.committed is False
