"""resolver_client (httpx クライアント) の単体テスト。

httpx.MockTransport で resolver サービスの応答を模す。
"""
from __future__ import annotations

import json

import httpx
import pytest

from app.core.config import settings
from app.services import resolver_client


def _patch_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """テスト用のダミー base/key を設定。"""
    monkeypatch.setattr(settings, "RESOLVER_BASE_URL", "http://resolver.test")
    monkeypatch.setattr(settings, "RESOLVER_API_KEY", "test-key-32-chars-long-padding-xx")
    monkeypatch.setattr(settings, "RESOLVER_TIMEOUT_MS", 5000)


def _install_transport(
    monkeypatch: pytest.MonkeyPatch,
    handler,  # type: ignore[no-untyped-def]
) -> None:
    """httpx.AsyncClient が使う transport を MockTransport に差し替える。"""
    transport = httpx.MockTransport(handler)
    real_init = httpx.AsyncClient.__init__

    def patched_init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs["transport"] = transport
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", patched_init)


@pytest.mark.asyncio
async def test_success_returns_mp4_url(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_settings(monkeypatch)
    received: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        received["url"] = str(request.url)
        received["auth"] = request.headers.get("Authorization")
        received["body"] = json.loads(request.content.decode())
        return httpx.Response(
            200, json={"content_id": "abc001", "mp4_url": "https://cdn.example/abc001.mp4"}
        )

    _install_transport(monkeypatch, handler)

    url = await resolver_client.resolve_mp4_url("abc001")
    assert url == "https://cdn.example/abc001.mp4"
    assert received["url"] == "http://resolver.test/resolve"
    assert received["auth"] == "Bearer test-key-32-chars-long-padding-xx"
    assert received["body"] == {"content_id": "abc001"}


@pytest.mark.asyncio
async def test_missing_config_raises_config_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "RESOLVER_BASE_URL", "")
    monkeypatch.setattr(settings, "RESOLVER_API_KEY", "")
    with pytest.raises(resolver_client.ResolverConfigError):
        await resolver_client.resolve_mp4_url("abc001")


@pytest.mark.asyncio
async def test_404_raises_not_found(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_settings(monkeypatch)

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"detail": "content not found"})

    _install_transport(monkeypatch, handler)

    with pytest.raises(resolver_client.ResolverNotFound):
        await resolver_client.resolve_mp4_url("xxx")


@pytest.mark.asyncio
async def test_502_raises_upstream_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_settings(monkeypatch)

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(502, json={"detail": "upstream"})

    _install_transport(monkeypatch, handler)

    with pytest.raises(resolver_client.ResolverUpstreamError):
        await resolver_client.resolve_mp4_url("xxx")


@pytest.mark.asyncio
async def test_504_raises_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_settings(monkeypatch)

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(504, json={"detail": "gateway timeout"})

    _install_transport(monkeypatch, handler)

    with pytest.raises(resolver_client.ResolverTimeout):
        await resolver_client.resolve_mp4_url("xxx")


@pytest.mark.asyncio
async def test_401_raises_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    """API キー不整合は呼び出し側の設定問題なので Unavailable 扱い。"""
    _patch_settings(monkeypatch)

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"detail": "invalid token"})

    _install_transport(monkeypatch, handler)

    with pytest.raises(resolver_client.ResolverUnavailable):
        await resolver_client.resolve_mp4_url("xxx")


@pytest.mark.asyncio
async def test_network_error_raises_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_settings(monkeypatch)

    def handler(_req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    _install_transport(monkeypatch, handler)

    with pytest.raises(resolver_client.ResolverUnavailable):
        await resolver_client.resolve_mp4_url("xxx")


@pytest.mark.asyncio
async def test_timeout_exception_raises_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_settings(monkeypatch)

    def handler(_req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("read timed out")

    _install_transport(monkeypatch, handler)

    with pytest.raises(resolver_client.ResolverTimeout):
        await resolver_client.resolve_mp4_url("xxx")


@pytest.mark.asyncio
async def test_200_without_mp4_url_raises_upstream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """resolver が 200 だが body に mp4_url が無いケースは upstream エラー扱い。"""
    _patch_settings(monkeypatch)

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"content_id": "abc"})

    _install_transport(monkeypatch, handler)

    with pytest.raises(resolver_client.ResolverUpstreamError):
        await resolver_client.resolve_mp4_url("abc")


def test_build_url_handles_trailing_slash() -> None:
    """末尾スラッシュの有無に関わらず正しい URL になる。"""
    assert (
        resolver_client._build_url("http://example.com", "/resolve")
        == "http://example.com/resolve"
    )
    assert (
        resolver_client._build_url("http://example.com/", "/resolve")
        == "http://example.com/resolve"
    )


# ─────────────────────────────────────────────
# in-flight デデュープ ・ 短期成功キャッシュ
# ─────────────────────────────────────────────
@pytest.mark.asyncio
async def test_concurrent_calls_dedupe_to_single_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """同じ content_id への並列呼びは resolver へ 1 リクエストしか転ばない。"""
    import asyncio

    _patch_settings(monkeypatch)
    call_count = 0
    started = asyncio.Event()
    proceed = asyncio.Event()

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        # 1 件目が走っている間に 2 件目を走らせるためにゲートを設ける。
        started.set()
        await proceed.wait()
        return httpx.Response(
            200,
            json={
                "content_id": "dup001",
                "mp4_url": "https://cdn.example/dup001.mp4",
            },
        )

    _install_transport(monkeypatch, handler)

    # 二つのタスクを同時に走らせる。
    task_a = asyncio.create_task(resolver_client.resolve_mp4_url("dup001"))
    # タスク A がロックを取って handler に入るまで待つ
    await started.wait()
    task_b = asyncio.create_task(resolver_client.resolve_mp4_url("dup001"))
    # B が in-flight デデュープに追従し future を共有するのを待ち、handler を進める
    await asyncio.sleep(0.05)
    proceed.set()

    url_a, url_b = await asyncio.gather(task_a, task_b)
    assert url_a == "https://cdn.example/dup001.mp4"
    assert url_b == url_a
    assert call_count == 1, f"expected 1 resolver call, got {call_count}"


@pytest.mark.asyncio
async def test_success_is_cached_for_short_period(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """成功結果は 60 秒間キャッシュされ、resolver は再呼びされない。"""
    _patch_settings(monkeypatch)
    call_count = 0

    def handler(_req: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(
            200,
            json={
                "content_id": "cache001",
                "mp4_url": "https://cdn.example/cache001.mp4",
            },
        )

    _install_transport(monkeypatch, handler)

    url1 = await resolver_client.resolve_mp4_url("cache001")
    url2 = await resolver_client.resolve_mp4_url("cache001")
    url3 = await resolver_client.resolve_mp4_url("cache001")
    assert url1 == url2 == url3 == "https://cdn.example/cache001.mp4"
    assert call_count == 1, f"expected 1 resolver call, got {call_count}"


@pytest.mark.asyncio
async def test_bypass_cache_forces_new_resolve(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """bypass_cache=True は短期キャッシュをスキップして、毎回 resolver を叩く。"""
    _patch_settings(monkeypatch)
    call_count = 0

    def handler(_req: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(
            200,
            json={
                "content_id": "force001",
                "mp4_url": f"https://cdn.example/force001-v{call_count}.mp4",
            },
        )

    _install_transport(monkeypatch, handler)

    url1 = await resolver_client.resolve_mp4_url("force001")
    url2 = await resolver_client.resolve_mp4_url("force001", bypass_cache=True)
    assert url1 == "https://cdn.example/force001-v1.mp4"
    assert url2 == "https://cdn.example/force001-v2.mp4"
    assert call_count == 2


@pytest.mark.asyncio
async def test_failure_propagates_to_inflight_waiters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """オーナー呼びが例外を出したとき、待機中の呼びも同じ例外で落ちる。"""
    import asyncio

    _patch_settings(monkeypatch)
    started = asyncio.Event()
    proceed = asyncio.Event()

    async def handler(_req: httpx.Request) -> httpx.Response:
        started.set()
        await proceed.wait()
        return httpx.Response(404, json={"detail": "not found"})

    _install_transport(monkeypatch, handler)

    task_a = asyncio.create_task(resolver_client.resolve_mp4_url("miss001"))
    await started.wait()
    task_b = asyncio.create_task(resolver_client.resolve_mp4_url("miss001"))
    await asyncio.sleep(0.05)
    proceed.set()

    with pytest.raises(resolver_client.ResolverNotFound):
        await task_a
    with pytest.raises(resolver_client.ResolverNotFound):
        await task_b

    # 失敗後はテーブルから抑り除かれている (次回呼びで handler が再そ走る)。
    assert "miss001" not in resolver_client._inflight
    assert "miss001" not in resolver_client._success_cache
