"""GET /movies/{slug}/resolve-mp4 エンドポイントのテスト。

DB キャッシュは廃止済み。endpoint は毎回 resolver_client.resolve_mp4_url
を呼んで MP4 URL を取得し、DB には一切書き込まない。

実 DB / 実 DMM は使わず:
  - DB セッションは _FakeSession で SELECT のみモック (UPDATE は走らないこと
    を assert する)
  - resolver_client.resolve_mp4_url を monkeypatch して各種挙動を再現
する。
"""
from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.db.session import get_db
from app.main import app
from app.services import resolver_client


FRESH_URL = (
    "https://cc3001.dmm.co.jp/pv/FRESHtoken/1sun00052amhb.mp4"
)


class _FakeRowResult:
    def __init__(self, row: tuple | None) -> None:
        self._row = row

    def first(self) -> tuple | None:
        return self._row


class _FakeSession:
    """SELECT は最初に渡された row を返す。UPDATE は呼ばれてはいけない。"""

    def __init__(self, row: tuple | None) -> None:
        self._row = row
        self.update_calls: list[Any] = []
        self.committed = False

    async def execute(self, statement: Any):  # type: ignore[no-untyped-def]
        compiled = str(statement).strip().upper()
        if compiled.startswith("SELECT"):
            return _FakeRowResult(self._row)
        # 本実装は UPDATE を発行しないので、もし呼ばれたら記録 (assert で検出)
        self.update_calls.append(statement)

        class _UpdateResult:
            rowcount = 0

        return _UpdateResult()

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


def test_resolves_on_demand_and_does_not_touch_db(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """毎回 resolver を呼び、DB に書き戻しは一切しない。"""
    row = ("1sun00052a",)
    client, session = _make_client(row)

    async def _fake_resolve(content_id: str, *, bypass_cache: bool = False) -> str:
        assert content_id == "1sun00052a"
        assert bypass_cache is False
        return FRESH_URL

    monkeypatch.setattr(resolver_client, "resolve_mp4_url", _fake_resolve)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {"content_id": "1sun00052a", "mp4_url": FRESH_URL}
    # DB への書き込み (UPDATE / commit) は一切走らない
    assert session.update_calls == []
    assert session.committed is False


def test_force_true_bypasses_in_process_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """force=true は resolver_client の短期キャッシュをバイパスして再抽出。"""
    row = ("1sun00052a",)
    client, _ = _make_client(row)

    async def _fake_resolve(content_id: str, *, bypass_cache: bool = False) -> str:
        # force=true → bypass_cache=True
        assert bypass_cache is True
        return FRESH_URL

    monkeypatch.setattr(resolver_client, "resolve_mp4_url", _fake_resolve)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4?force=true")
    assert resp.status_code == 200
    assert resp.json()["mp4_url"] == FRESH_URL


def test_movie_not_found_returns_404() -> None:
    client, _ = _make_client(None)
    resp = client.get("/api/v1/movies/does-not-exist/resolve-mp4")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Movie not found"


def test_missing_content_id_returns_404() -> None:
    """content_id が空のとき 404 (resolver は content_id 必須)。"""
    row = (None,)
    client, _ = _make_client(row)
    resp = client.get("/api/v1/movies/no-cid/resolve-mp4")
    assert resp.status_code == 404
    assert "content_id" in resp.json()["detail"]


def test_resolver_not_found_propagates_as_404(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = ("1sun00052a",)
    client, _ = _make_client(row)

    async def _raise(content_id: str, *, bypass_cache: bool = False) -> str:  # noqa: ARG001
        raise resolver_client.ResolverNotFound("not found upstream")

    monkeypatch.setattr(resolver_client, "resolve_mp4_url", _raise)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 404


def test_resolver_timeout_propagates_as_504(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = ("1sun00052a",)
    client, _ = _make_client(row)

    async def _raise(content_id: str, *, bypass_cache: bool = False) -> str:  # noqa: ARG001
        raise resolver_client.ResolverTimeout("slow")

    monkeypatch.setattr(resolver_client, "resolve_mp4_url", _raise)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 504


def test_resolver_upstream_propagates_as_502(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = ("1sun00052a",)
    client, _ = _make_client(row)

    async def _raise(content_id: str, *, bypass_cache: bool = False) -> str:  # noqa: ARG001
        raise resolver_client.ResolverUpstreamError("dmm broken")

    monkeypatch.setattr(resolver_client, "resolve_mp4_url", _raise)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 502


def test_resolver_config_error_returns_500(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = ("1sun00052a",)
    client, _ = _make_client(row)

    async def _raise(content_id: str, *, bypass_cache: bool = False) -> str:  # noqa: ARG001
        raise resolver_client.ResolverConfigError("not set")

    monkeypatch.setattr(resolver_client, "resolve_mp4_url", _raise)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 500
