"""FastAPI エンドポイントのテスト。

Playwright 起動を回避するため lifespan をバイパスし、
BrowserPool と extract_mp4_url をモック化する。
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

from src import main as main_module
from src.resolver import (
    ResolveNotFound,
    ResolveResult,
    ResolveTimeout,
    ResolveUpstream,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_app_with_pool(monkeypatch, extract_mock):
    """lifespan を差し替えた app を作って TestClient を返す。"""

    # 設定値を上書き
    monkeypatch.setattr(main_module.settings, "resolver_api_key", "test-key")
    monkeypatch.setattr(main_module.settings, "dmm_affiliate_id", "affi-001")

    # extract_mp4_url を差し替え
    monkeypatch.setattr(main_module, "extract_mp4_url", extract_mock)

    # BrowserPool もモック化 (Playwright を起動しない)
    fake_pool = MagicMock()
    fake_pool.start = AsyncMock(return_value=None)
    fake_pool.stop = AsyncMock(return_value=None)
    fake_pool.get_browser = MagicMock(return_value=MagicMock())
    fake_pool.is_running = True

    class _Slot:
        async def __aenter__(self_inner):
            return None

        async def __aexit__(self_inner, *a):
            return None

    fake_pool.slot = MagicMock(return_value=_Slot())

    @asynccontextmanager
    async def fake_lifespan(app):
        app.state.browser_pool = fake_pool
        yield

    # FastAPI の lifespan を差し替え
    monkeypatch.setattr(main_module.app.router, "lifespan_context", fake_lifespan)

    return TestClient(main_module.app)


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------


def test_health_returns_ok(monkeypatch):
    extract = AsyncMock()
    with _make_app_with_pool(monkeypatch, extract) as client:
        res = client.get("/health")
        assert res.status_code == 200
        body = res.json()
        assert body["status"] == "ok"
        assert body["browser_running"] is True


# ---------------------------------------------------------------------------
# /resolve 認証
# ---------------------------------------------------------------------------


def test_resolve_requires_bearer(monkeypatch):
    extract = AsyncMock(
        return_value=ResolveResult(
            content_id="1sun00052a",
            mp4_url="https://cc3001.dmm.co.jp/pv/x/y.mp4",
        )
    )
    with _make_app_with_pool(monkeypatch, extract) as client:
        # ヘッダなし
        res = client.post("/resolve", json={"content_id": "1sun00052a"})
        assert res.status_code == 401

        # 不正トークン
        res = client.post(
            "/resolve",
            json={"content_id": "1sun00052a"},
            headers={"Authorization": "Bearer wrong"},
        )
        assert res.status_code == 401


def test_resolve_succeeds_with_correct_bearer(monkeypatch):
    extract = AsyncMock(
        return_value=ResolveResult(
            content_id="1sun00052a",
            mp4_url="https://cc3001.dmm.co.jp/pv/abc/x_mhb_w.mp4",
        )
    )
    with _make_app_with_pool(monkeypatch, extract) as client:
        res = client.post(
            "/resolve",
            json={"content_id": "1sun00052a"},
            headers={"Authorization": "Bearer test-key"},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["content_id"] == "1sun00052a"
        assert body["mp4_url"].endswith(".mp4")


# ---------------------------------------------------------------------------
# /resolve 例外マッピング
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "exc,expected_status",
    [
        (ResolveNotFound("not found"), 404),
        (ResolveTimeout("timeout"), 504),
        (ResolveUpstream("upstream"), 502),
    ],
)
def test_resolve_maps_exceptions_to_http_status(monkeypatch, exc, expected_status):
    extract = AsyncMock(side_effect=exc)
    with _make_app_with_pool(monkeypatch, extract) as client:
        res = client.post(
            "/resolve",
            json={"content_id": "1sun00052a"},
            headers={"Authorization": "Bearer test-key"},
        )
        assert res.status_code == expected_status


def test_resolve_uses_default_affiliate_id_when_omitted(monkeypatch):
    """リクエストに affiliate_id がなくても DMM_AFFILIATE_ID で動く。"""
    captured = {}

    async def fake_extract(browser, content_id, affiliate_id, **kwargs):
        captured["affiliate_id"] = affiliate_id
        return ResolveResult(content_id=content_id, mp4_url="https://x/y.mp4")

    with _make_app_with_pool(monkeypatch, fake_extract) as client:
        res = client.post(
            "/resolve",
            json={"content_id": "1sun00052a"},
            headers={"Authorization": "Bearer test-key"},
        )
        assert res.status_code == 200
        assert captured["affiliate_id"] == "affi-001"
