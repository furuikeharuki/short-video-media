"""GET /movies/{slug}/resolve-mp4 エンドポイントのテスト。

実 DB / 実 resolver は使わず、

  - DB セッションは _FakeSession で SELECT/UPDATE をモック
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


CACHED_URL = (
    "https://cc3001.dmm.co.jp/pv/CACHEDtoken/1sun00052amhb.mp4"
)
FRESH_URL = (
    "https://cc3001.dmm.co.jp/pv/FRESHtoken/1sun00052amhb.mp4"
)
# 旧形式 (ORB で弾かれる) URL。DB に入っていてもキャッシュとして採用しない。
LEGACY_MHB_URL = (
    "https://cc3001.dmm.co.jp/litevideo/freepv/a/akd/akdl046a/akdl046a_mhb_w.mp4"
)
LEGACY_DM_URL = (
    "https://cc3001.dmm.co.jp/litevideo/freepv/h/hmd/hmdnc922/hmdnc922_dm_w.mp4"
)


# ─────────────────────────────────────────────
# DB セッションのフェイク
# ─────────────────────────────────────────────
class _FakeRowResult:
    """SQLAlchemy の Result.first() を模す。"""

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
        # SQLAlchemy の statement は str() で SQL に展開できる。
        # 簡易判定: 先頭が SELECT なら row を返し、UPDATE なら記録するだけ。
        compiled = str(statement).strip().upper()
        if compiled.startswith("SELECT"):
            return _FakeRowResult(self._row)
        # UPDATE 系
        self.update_calls.append(statement)
        return _FakeUpdateResult()

    async def commit(self) -> None:
        self.committed = True


def _make_client(row: tuple | None) -> tuple[TestClient, _FakeSession]:
    """指定 row を返す DB を差し込んだ TestClient を作る。"""
    session = _FakeSession(row)

    async def _fake_get_db():  # type: ignore[no-untyped-def]
        yield session

    app.dependency_overrides[get_db] = _fake_get_db
    return TestClient(app), session


@pytest.fixture(autouse=True)
def _cleanup_overrides() -> Iterator[None]:
    """各テスト後に dependency_overrides をクリーンする。"""
    yield
    app.dependency_overrides.pop(get_db, None)


# ─────────────────────────────────────────────
# テスト本体
# ─────────────────────────────────────────────
def test_returns_cached_url_without_calling_resolver(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """DB に sample_movie_url があり force=false なら resolver を呼ばずに返す。"""
    row = ("movie-uuid", "1sun00052a", CACHED_URL)
    client, session = _make_client(row)

    called = {"n": 0}

    async def _should_not_be_called(content_id: str) -> str:  # noqa: ARG001
        called["n"] += 1
        return FRESH_URL

    monkeypatch.setattr(
        resolver_client, "resolve_mp4_url", _should_not_be_called
    )

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {
        "content_id": "1sun00052a",
        "mp4_url": CACHED_URL,
        "cached": True,
    }
    assert called["n"] == 0
    # キャッシュヒット時は UPDATE が走らない
    assert session.update_calls == []


def test_calls_resolver_when_cache_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """DB の sample_movie_url が空なら resolver を呼んで DB に書き戻す。"""
    row = ("movie-uuid", "1sun00052a", None)
    client, session = _make_client(row)

    async def _fake_resolve(content_id: str, *, bypass_cache: bool = False) -> str:
        assert content_id == "1sun00052a"
        # キャッシュが空だが force=False なので bypass_cache=False
        assert bypass_cache is False
        return FRESH_URL

    monkeypatch.setattr(resolver_client, "resolve_mp4_url", _fake_resolve)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {
        "content_id": "1sun00052a",
        "mp4_url": FRESH_URL,
        "cached": False,
    }
    # 書き戻し + commit されている
    assert len(session.update_calls) == 1
    assert session.committed is True


def test_force_true_bypasses_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """force=true なら DB に値があっても必ず resolver を呼ぶ。"""
    row = ("movie-uuid", "1sun00052a", CACHED_URL)
    client, session = _make_client(row)

    async def _fake_resolve(content_id: str, *, bypass_cache: bool = False) -> str:  # noqa: ARG001
        # force=true なので 短期キャッシュもスキップさせるため bypass_cache=True が渡る
        assert bypass_cache is True
        return FRESH_URL

    monkeypatch.setattr(resolver_client, "resolve_mp4_url", _fake_resolve)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4?force=true")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["mp4_url"] == FRESH_URL
    assert body["cached"] is False
    assert len(session.update_calls) == 1
    assert session.committed is True


def test_movie_not_found_returns_404(
    monkeypatch: pytest.MonkeyPatch,  # noqa: ARG001
) -> None:
    """DB に該当 slug が無ければ 404。"""
    client, _ = _make_client(None)
    resp = client.get("/api/v1/movies/does-not-exist/resolve-mp4")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Movie not found"


def test_missing_content_id_returns_404(
    monkeypatch: pytest.MonkeyPatch,  # noqa: ARG001
) -> None:
    """content_id が空でキャッシュも無いケースは 404。"""
    row = ("movie-uuid", None, None)
    client, _ = _make_client(row)
    resp = client.get("/api/v1/movies/no-cid/resolve-mp4")
    assert resp.status_code == 404
    assert "content_id" in resp.json()["detail"]


def test_resolver_not_found_propagates_as_404(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = ("movie-uuid", "1sun00052a", None)
    client, _ = _make_client(row)

    async def _raise(content_id: str, *, bypass_cache: bool = False) -> str:  # noqa: ARG001
        raise resolver_client.ResolverNotFound("not found upstream")

    monkeypatch.setattr(resolver_client, "resolve_mp4_url", _raise)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 404


def test_resolver_timeout_propagates_as_504(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = ("movie-uuid", "1sun00052a", None)
    client, _ = _make_client(row)

    async def _raise(content_id: str, *, bypass_cache: bool = False) -> str:  # noqa: ARG001
        raise resolver_client.ResolverTimeout("slow")

    monkeypatch.setattr(resolver_client, "resolve_mp4_url", _raise)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 504


def test_resolver_upstream_error_propagates_as_502(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = ("movie-uuid", "1sun00052a", None)
    client, _ = _make_client(row)

    async def _raise(content_id: str, *, bypass_cache: bool = False) -> str:  # noqa: ARG001
        raise resolver_client.ResolverUpstreamError("dmm broken")

    monkeypatch.setattr(resolver_client, "resolve_mp4_url", _raise)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 502


def test_resolver_config_error_returns_500(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = ("movie-uuid", "1sun00052a", None)
    client, _ = _make_client(row)

    async def _raise(content_id: str, *, bypass_cache: bool = False) -> str:  # noqa: ARG001
        raise resolver_client.ResolverConfigError("not set")

    monkeypatch.setattr(resolver_client, "resolve_mp4_url", _raise)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 500


def test_resolver_unavailable_falls_back_to_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """resolver が落ちていても、キャッシュがあり force=false なら 200 で返す。"""
    row = ("movie-uuid", "1sun00052a", CACHED_URL)
    client, _ = _make_client(row)

    async def _raise(content_id: str, *, bypass_cache: bool = False) -> str:  # noqa: ARG001
        raise resolver_client.ResolverUnavailable("connection refused")

    monkeypatch.setattr(resolver_client, "resolve_mp4_url", _raise)

    # force=true で呼ぶ → キャッシュは無視されるので 502 になる
    resp = client.get("/api/v1/movies/some-slug/resolve-mp4?force=true")
    assert resp.status_code == 502

    # force=false かつ cache あり → cache を返す
    resp2 = client.get("/api/v1/movies/some-slug/resolve-mp4")
    # ※ row には cached_url が入っているので、まず force=false でキャッシュヒット経路に入る
    # (resolver は呼ばれない)
    assert resp2.status_code == 200
    assert resp2.json()["cached"] is True


def test_resolver_unavailable_without_cache_returns_502(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """キャッシュ無し + resolver も落ちていたら 502。"""
    row = ("movie-uuid", "1sun00052a", None)
    client, _ = _make_client(row)

    async def _raise(content_id: str, *, bypass_cache: bool = False) -> str:  # noqa: ARG001
        raise resolver_client.ResolverUnavailable("network down")

    monkeypatch.setattr(resolver_client, "resolve_mp4_url", _raise)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 502


# ──────────────────────────────────────────────────
# 旧形式 URL ガード (PR #48)
# ──────────────────────────────────────────────────
def test_legacy_mhb_url_in_cache_is_ignored_and_resolver_called(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """DB に旧形式 _mhb_w.mp4 が保存されていてもキャッシュとして採用せず、resolver を呼ぶ。"""
    row = ("movie-uuid", "1sun00052a", LEGACY_MHB_URL)
    client, session = _make_client(row)

    called = {"n": 0}

    async def _fake_resolve(content_id: str, *, bypass_cache: bool = False) -> str:  # noqa: ARG001
        called["n"] += 1
        # 旧形式検出による resolver 呼び出しは force=False 扱いなので、bypass_cache=False
        assert bypass_cache is False
        return FRESH_URL

    monkeypatch.setattr(resolver_client, "resolve_mp4_url", _fake_resolve)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["mp4_url"] == FRESH_URL
    assert body["cached"] is False
    assert called["n"] == 1
    # 新 URL を書き戻している
    assert len(session.update_calls) == 1
    assert session.committed is True


def test_legacy_dm_url_in_cache_is_ignored_and_resolver_called(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """_dm_w.mp4 も _mhb_w.mp4 と同じくスキップされて resolver が呼ばれる。"""
    row = ("movie-uuid", "1sun00052a", LEGACY_DM_URL)
    client, _ = _make_client(row)

    async def _fake_resolve(content_id: str, *, bypass_cache: bool = False) -> str:  # noqa: ARG001
        return FRESH_URL

    monkeypatch.setattr(resolver_client, "resolve_mp4_url", _fake_resolve)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 200, resp.text
    assert resp.json()["mp4_url"] == FRESH_URL
    assert resp.json()["cached"] is False


def test_legacy_url_resolver_unavailable_does_not_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """旧形式 URL は resolver ダウン時もフォールバックしない。フォールバックしても再生できないため。"""
    row = ("movie-uuid", "1sun00052a", LEGACY_MHB_URL)
    client, _ = _make_client(row)

    async def _raise(content_id: str, *, bypass_cache: bool = False) -> str:  # noqa: ARG001
        raise resolver_client.ResolverUnavailable("network down")

    monkeypatch.setattr(resolver_client, "resolve_mp4_url", _raise)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    # 旧形式なのでキャッシュフォールバックされず 502。
    assert resp.status_code == 502


def test_new_format_url_is_used_as_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """新形式 (_sm_s / _dmb_s) はキャッシュとしてそのまま使う。"""
    new_url = "https://cc3001.dmm.co.jp/litevideo/freepv/a/akd/akdl046a/akdl046a_sm_s.mp4"
    row = ("movie-uuid", "1sun00052a", new_url)
    client, _ = _make_client(row)

    called = {"n": 0}

    async def _should_not_be_called(content_id: str, *, bypass_cache: bool = False) -> str:  # noqa: ARG001
        called["n"] += 1
        return FRESH_URL

    monkeypatch.setattr(resolver_client, "resolve_mp4_url", _should_not_be_called)

    resp = client.get("/api/v1/movies/some-slug/resolve-mp4")
    assert resp.status_code == 200
    assert resp.json()["mp4_url"] == new_url
    assert resp.json()["cached"] is True
    assert called["n"] == 0
