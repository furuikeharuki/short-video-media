"""GET /movies/{slug}/resolve-mp4 エンドポイントのテスト。

新方針 (DB キャッシュ + 都度フォールバック):
  - DB に MP4 URL が保存済みで force=false なら、resolver を呼ばずに DB 値を返す。
  - DB に無い / force=true なら resolver で抽出し、取得した URL で DB を更新する。

実 DB / 実 DMM は使わず:
  - DB セッションは _FakeSession で SELECT (movies 行) をモックし、
    UPDATE / commit が走ったかどうかを記録する。
  - resolver_client.resolve_mp4 を monkeypatch して各種挙動を再現する。
"""
from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.db.session import get_db
from app.main import app
from app.services import resolver_client


FRESH_URL = "https://cc3001.dmm.co.jp/pv/FRESHtoken/1sun00052amhb.mp4"
LOW_URL = "https://cc3001.dmm.co.jp/pv/FRESHtoken/1sun00052adm_w.mp4"
HIGH_URL = "https://cc3001.dmm.co.jp/pv/FRESHtoken/1sun00052amhb_w.mp4"

STORED_MP4 = "https://cc3001.dmm.co.jp/pv/STOREDtoken/1sun00052amhb.mp4"
STORED_LOW = "https://cc3001.dmm.co.jp/pv/STOREDtoken/1sun00052adm_w.mp4"
STORED_HIGH = "https://cc3001.dmm.co.jp/pv/STOREDtoken/1sun00052amhb_w.mp4"

MOVIE_ID = "00000000-0000-0000-0000-000000000001"


class _FakeRowResult:
    def __init__(self, row: tuple | None) -> None:
        self._row = row

    def first(self) -> tuple | None:
        return self._row


class _FakeSession:
    """SELECT は渡された row を返す。UPDATE / commit は記録する。

    row は endpoint の SELECT に合わせた
    (id, content_id, sample_mp4_url, sample_low_mp4_url, sample_high_mp4_url) の
    5-tuple、または None (該当作品なし)。
    """

    def __init__(self, row: tuple | None) -> None:
        self._row = row
        self.update_calls: list[Any] = []
        self.committed = False
        self.rolled_back = False

    async def execute(self, statement: Any):  # type: ignore[no-untyped-def]
        compiled = str(statement).strip().upper()
        if compiled.startswith("SELECT"):
            return _FakeRowResult(self._row)
        # UPDATE を記録
        self.update_calls.append(statement)

        class _UpdateResult:
            rowcount = 1

        return _UpdateResult()

    async def commit(self) -> None:
        self.committed = True

    async def rollback(self) -> None:
        self.rolled_back = True


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


def _row(content_id="1sun00052a", mp4=None, low=None, high=None) -> tuple:
    return (MOVIE_ID, content_id, mp4, low, high)


# ─────────────────────────────────────────────
# DB キャッシュヒット (resolver を呼ばない)
# ─────────────────────────────────────────────
def test_returns_stored_urls_without_calling_resolver(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """DB に保存済み URL があり force=false なら、resolver を呼ばず DB 値を返す。"""
    client, session = _make_client(
        _row(mp4=STORED_MP4, low=STORED_LOW, high=STORED_HIGH)
    )

    called = {"n": 0}

    async def _fake_resolve(*args, **kwargs):  # noqa: ARG001
        called["n"] += 1
        raise AssertionError("resolver must not be called on DB cache hit")

    monkeypatch.setattr(resolver_client, "resolve_mp4", _fake_resolve)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "content_id": "1sun00052a",
        "mp4_url": STORED_MP4,
        "low_mp4_url": STORED_LOW,
        "high_mp4_url": STORED_HIGH,
    }
    assert called["n"] == 0
    # DB キャッシュヒットでは UPDATE / commit は走らない
    assert session.update_calls == []
    assert session.committed is False


def test_stored_url_low_high_fallback_to_mp4(monkeypatch: pytest.MonkeyPatch) -> None:
    """DB に mp4 のみ (low/high NULL) 保存されていても、応答は mp4 にフォールバックする。"""
    client, _ = _make_client(_row(mp4=STORED_MP4, low=None, high=None))

    async def _fake_resolve(*args, **kwargs):  # noqa: ARG001
        raise AssertionError("resolver must not be called on DB cache hit")

    monkeypatch.setattr(resolver_client, "resolve_mp4", _fake_resolve)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 200
    body = resp.json()
    assert body["mp4_url"] == STORED_MP4
    assert body["low_mp4_url"] == STORED_MP4
    assert body["high_mp4_url"] == STORED_MP4


# ─────────────────────────────────────────────
# DB ミス → resolver 抽出 + DB 更新
# ─────────────────────────────────────────────
def test_resolves_and_persists_when_db_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """DB に URL が無ければ resolver を呼び、取得した URL で DB を更新する。"""
    client, session = _make_client(_row(mp4=None, low=None, high=None))

    async def _fake_resolve(content_id: str, *, bypass_cache: bool = False, **kwargs):  # noqa: ARG001
        assert content_id == "1sun00052a"
        assert bypass_cache is False
        return resolver_client.ResolvedMp4(
            mp4_url=HIGH_URL, low_mp4_url=LOW_URL, high_mp4_url=HIGH_URL
        )

    monkeypatch.setattr(resolver_client, "resolve_mp4", _fake_resolve)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "content_id": "1sun00052a",
        "mp4_url": HIGH_URL,
        "low_mp4_url": LOW_URL,
        "high_mp4_url": HIGH_URL,
    }
    # 抽出結果が DB に書き戻される
    assert len(session.update_calls) == 1
    assert session.committed is True


def test_persist_falls_back_low_high_to_mp4(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """resolver が low/high=None を返しても、応答と保存値は mp4_url にフォールバックする。"""
    client, session = _make_client(_row(mp4=None))

    async def _fake_resolve(content_id: str, *, bypass_cache: bool = False, **kwargs):  # noqa: ARG001
        return resolver_client.ResolvedMp4(
            mp4_url=FRESH_URL, low_mp4_url=None, high_mp4_url=None
        )

    monkeypatch.setattr(resolver_client, "resolve_mp4", _fake_resolve)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 200
    body = resp.json()
    assert body["mp4_url"] == FRESH_URL
    assert body["low_mp4_url"] == FRESH_URL
    assert body["high_mp4_url"] == FRESH_URL
    assert session.committed is True


# ─────────────────────────────────────────────
# force=true: 保存済みでも再抽出 + DB 更新
# ─────────────────────────────────────────────
def test_force_true_bypasses_db_and_updates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """force=true は DB 保存値を短絡せず resolver で再抽出し、DB を更新する。"""
    client, session = _make_client(
        _row(mp4=STORED_MP4, low=STORED_LOW, high=STORED_HIGH)
    )

    async def _fake_resolve(content_id: str, *, bypass_cache: bool = False, **kwargs):  # noqa: ARG001
        # force=true → bypass_cache=True で DMM 再アクセス
        assert bypass_cache is True
        return resolver_client.ResolvedMp4(
            mp4_url=FRESH_URL, low_mp4_url=FRESH_URL, high_mp4_url=FRESH_URL
        )

    monkeypatch.setattr(resolver_client, "resolve_mp4", _fake_resolve)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4?force=true")
    assert resp.status_code == 200
    # 直前に再生失敗した stale な DB URL ではなく、再抽出した新 URL を返す
    assert resp.json()["mp4_url"] == FRESH_URL
    # DB も新 URL で更新される
    assert len(session.update_calls) == 1
    assert session.committed is True


# ─────────────────────────────────────────────
# エラー系
# ─────────────────────────────────────────────
def test_movie_not_found_returns_404() -> None:
    client, _ = _make_client(None)
    resp = client.get("/api/v1/movies/does-not-exist/resolve-mp4")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Movie not found"


def test_missing_content_id_and_no_stored_returns_404() -> None:
    """content_id が空 + 保存済み URL も無いとき 404 (resolver は content_id 必須)。"""
    client, _ = _make_client(_row(content_id=None, mp4=None))
    resp = client.get("/api/v1/movies/no-cid/resolve-mp4")
    assert resp.status_code == 404
    assert "content_id" in resp.json()["detail"]


def test_missing_content_id_but_stored_returns_db(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """content_id が無くても DB に URL があれば、それを返す (resolver は呼べない)。"""
    client, _ = _make_client(
        _row(content_id=None, mp4=STORED_MP4, low=STORED_LOW, high=STORED_HIGH)
    )

    async def _fake_resolve(*args, **kwargs):  # noqa: ARG001
        raise AssertionError("resolver must not be called")

    monkeypatch.setattr(resolver_client, "resolve_mp4", _fake_resolve)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 200
    assert resp.json()["mp4_url"] == STORED_MP4


def test_resolver_not_found_propagates_as_404(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, _ = _make_client(_row(mp4=None))

    async def _raise(content_id: str, *, bypass_cache: bool = False, **kwargs):  # noqa: ARG001
        raise resolver_client.ResolverNotFound("not found upstream")

    monkeypatch.setattr(resolver_client, "resolve_mp4", _raise)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 404


def test_resolver_timeout_propagates_as_504(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, _ = _make_client(_row(mp4=None))

    async def _raise(content_id: str, *, bypass_cache: bool = False, **kwargs):  # noqa: ARG001
        raise resolver_client.ResolverTimeout("slow")

    monkeypatch.setattr(resolver_client, "resolve_mp4", _raise)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 504


def test_resolver_upstream_propagates_as_502(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, _ = _make_client(_row(mp4=None))

    async def _raise(content_id: str, *, bypass_cache: bool = False, **kwargs):  # noqa: ARG001
        raise resolver_client.ResolverUpstreamError("dmm broken")

    monkeypatch.setattr(resolver_client, "resolve_mp4", _raise)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 502


def test_resolver_config_error_returns_500(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, _ = _make_client(_row(mp4=None))

    async def _raise(content_id: str, *, bypass_cache: bool = False, **kwargs):  # noqa: ARG001
        raise resolver_client.ResolverConfigError("not set")

    monkeypatch.setattr(resolver_client, "resolve_mp4", _raise)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 500
