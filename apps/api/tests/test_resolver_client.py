"""resolver_client (in-process httpx 抽出) の単体テスト。

extractor を monkeypatch で差し替えて、resolver_client の責務である

  - DMM_AFFILIATE_ID 未設定の検出
  - 例外クラスの変換
  - in-flight デデュープ + 短期成功キャッシュ

を検証する。
"""
from __future__ import annotations

import asyncio

import pytest

from app.resolver.extractor import (
    ResolveNotFound,
    ResolveResult,
    ResolveTimeout,
    ResolveUpstream,
)
from app.services import resolver_client


def _set_affiliate(monkeypatch: pytest.MonkeyPatch, value: str = "test-affi-001") -> None:
    monkeypatch.setenv("DMM_AFFILIATE_ID", value)


def _patch_extract(
    monkeypatch: pytest.MonkeyPatch,
    func,
) -> None:
    """resolver_client が呼ぶ extract_mp4_url を差し替える。"""
    monkeypatch.setattr(resolver_client, "extract_mp4_url", func)


@pytest.mark.asyncio
async def test_success_returns_mp4_url(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_affiliate(monkeypatch)
    called: dict = {}

    async def fake_extract(*, content_id, affiliate_id, timeout_s, client=None):
        called["content_id"] = content_id
        called["affiliate_id"] = affiliate_id
        called["timeout_s"] = timeout_s
        called["client"] = client
        return ResolveResult(content_id=content_id, mp4_url="https://cdn.example/abc.mp4")

    _patch_extract(monkeypatch, fake_extract)

    url = await resolver_client.resolve_mp4_url("abc001")
    assert url == "https://cdn.example/abc.mp4"
    assert called["content_id"] == "abc001"
    assert called["affiliate_id"] == "test-affi-001"
    # デフォルトタイムアウト
    assert called["timeout_s"] == 10.0
    # 共有 httpx.AsyncClient が渡されている (keep-alive 維持のため)
    assert called["client"] is not None


@pytest.mark.asyncio
async def test_missing_affiliate_raises_config_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DMM_AFFILIATE_ID", "")
    with pytest.raises(resolver_client.ResolverConfigError):
        await resolver_client.resolve_mp4_url("abc001")


@pytest.mark.asyncio
async def test_not_found_is_mapped(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_affiliate(monkeypatch)

    async def fake_extract(**_kw):
        raise ResolveNotFound("no args")

    _patch_extract(monkeypatch, fake_extract)

    with pytest.raises(resolver_client.ResolverNotFound):
        await resolver_client.resolve_mp4_url("xxx")


@pytest.mark.asyncio
async def test_timeout_is_mapped(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_affiliate(monkeypatch)

    async def fake_extract(**_kw):
        raise ResolveTimeout("slow")

    _patch_extract(monkeypatch, fake_extract)

    with pytest.raises(resolver_client.ResolverTimeout):
        await resolver_client.resolve_mp4_url("xxx")


@pytest.mark.asyncio
async def test_upstream_is_mapped(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_affiliate(monkeypatch)

    async def fake_extract(**_kw):
        raise ResolveUpstream("dmm broken")

    _patch_extract(monkeypatch, fake_extract)

    with pytest.raises(resolver_client.ResolverUpstreamError):
        await resolver_client.resolve_mp4_url("xxx")


@pytest.mark.asyncio
async def test_custom_timeout_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_affiliate(monkeypatch)
    monkeypatch.setenv("RESOLVER_TIMEOUT_MS", "5000")
    seen: dict = {}

    async def fake_extract(*, content_id, affiliate_id, timeout_s, client=None):
        seen["timeout_s"] = timeout_s
        return ResolveResult(content_id=content_id, mp4_url="https://cdn.example/x.mp4")

    _patch_extract(monkeypatch, fake_extract)

    await resolver_client.resolve_mp4_url("any_cid")
    assert seen["timeout_s"] == 5.0


# ─────────────────────────────────────────────
# in-flight デデュープ ・ 短期成功キャッシュ
# ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_concurrent_calls_dedupe_to_single_extract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """同じ content_id への並列呼びは extract を 1 回しか呼ばない。"""
    _set_affiliate(monkeypatch)
    call_count = 0
    proceed = asyncio.Event()
    started = asyncio.Event()

    async def fake_extract(**kw):
        nonlocal call_count
        call_count += 1
        started.set()
        await proceed.wait()
        return ResolveResult(
            content_id=kw["content_id"], mp4_url="https://cdn.example/dup.mp4"
        )

    _patch_extract(monkeypatch, fake_extract)

    task_a = asyncio.create_task(resolver_client.resolve_mp4_url("dup001"))
    await started.wait()
    task_b = asyncio.create_task(resolver_client.resolve_mp4_url("dup001"))
    await asyncio.sleep(0.05)
    proceed.set()

    url_a, url_b = await asyncio.gather(task_a, task_b)
    assert url_a == url_b == "https://cdn.example/dup.mp4"
    assert call_count == 1


@pytest.mark.asyncio
async def test_success_is_cached_for_short_period(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """成功結果は 1 時間キャッシュされ、extract は再呼びされない。"""
    _set_affiliate(monkeypatch)
    call_count = 0

    async def fake_extract(**kw):
        nonlocal call_count
        call_count += 1
        return ResolveResult(
            content_id=kw["content_id"],
            mp4_url="https://cdn.example/cache001.mp4",
        )

    _patch_extract(monkeypatch, fake_extract)

    url1 = await resolver_client.resolve_mp4_url("cache001")
    url2 = await resolver_client.resolve_mp4_url("cache001")
    url3 = await resolver_client.resolve_mp4_url("cache001")
    assert url1 == url2 == url3 == "https://cdn.example/cache001.mp4"
    assert call_count == 1


@pytest.mark.asyncio
async def test_bypass_cache_forces_new_extract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_affiliate(monkeypatch)
    call_count = 0

    async def fake_extract(**kw):
        nonlocal call_count
        call_count += 1
        return ResolveResult(
            content_id=kw["content_id"],
            mp4_url=f"https://cdn.example/force-v{call_count}.mp4",
        )

    _patch_extract(monkeypatch, fake_extract)

    url1 = await resolver_client.resolve_mp4_url("force001")
    url2 = await resolver_client.resolve_mp4_url("force001", bypass_cache=True)
    assert url1 == "https://cdn.example/force-v1.mp4"
    assert url2 == "https://cdn.example/force-v2.mp4"
    assert call_count == 2


@pytest.mark.asyncio
async def test_failure_propagates_to_inflight_waiters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """オーナー呼びが例外を出したとき、待機中の呼びも同じ例外で落ちる。"""
    _set_affiliate(monkeypatch)
    started = asyncio.Event()
    proceed = asyncio.Event()

    async def fake_extract(**_kw):
        started.set()
        await proceed.wait()
        raise ResolveNotFound("not found")

    _patch_extract(monkeypatch, fake_extract)

    task_a = asyncio.create_task(resolver_client.resolve_mp4_url("fail001"))
    await started.wait()
    task_b = asyncio.create_task(resolver_client.resolve_mp4_url("fail001"))
    await asyncio.sleep(0.05)
    proceed.set()

    with pytest.raises(resolver_client.ResolverNotFound):
        await task_a
    with pytest.raises(resolver_client.ResolverNotFound):
        await task_b
