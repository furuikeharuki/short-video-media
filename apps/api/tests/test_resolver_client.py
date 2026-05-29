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
async def test_resolve_mp4_returns_low_high_candidates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`resolve_mp4` は extractor から low/high 両候補を引き継いで返す。"""
    _set_affiliate(monkeypatch)

    async def fake_extract(*, content_id, **_kw):
        return ResolveResult(
            content_id=content_id,
            mp4_url="https://cdn.example/primary.mp4",
            low_mp4_url="https://cdn.example/low.mp4",
            high_mp4_url="https://cdn.example/high.mp4",
        )

    _patch_extract(monkeypatch, fake_extract)

    resolved = await resolver_client.resolve_mp4("cand001")
    assert resolved.mp4_url == "https://cdn.example/primary.mp4"
    assert resolved.low_mp4_url == "https://cdn.example/low.mp4"
    assert resolved.high_mp4_url == "https://cdn.example/high.mp4"


@pytest.mark.asyncio
async def test_resolve_mp4_caches_full_candidate_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """成功時の short-term cache は low/high まで含めて保存し、再呼出しで使い回す。"""
    _set_affiliate(monkeypatch)
    call_count = 0

    async def fake_extract(*, content_id, **_kw):
        nonlocal call_count
        call_count += 1
        return ResolveResult(
            content_id=content_id,
            mp4_url=f"https://cdn.example/primary-v{call_count}.mp4",
            low_mp4_url="https://cdn.example/low.mp4",
            high_mp4_url="https://cdn.example/high.mp4",
        )

    _patch_extract(monkeypatch, fake_extract)
    resolver_client._reset_state_for_tests()

    first = await resolver_client.resolve_mp4("cache_cand001")
    second = await resolver_client.resolve_mp4("cache_cand001")
    assert call_count == 1
    assert first == second
    assert second.low_mp4_url == "https://cdn.example/low.mp4"
    assert second.high_mp4_url == "https://cdn.example/high.mp4"


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


# ─────────────────────────────────────────────
# レートリミット (owner だけ消費する設計)
# ─────────────────────────────────────────────
class _FakeRequest:
    """SlidingWindowRateLimiter.check が読む最小プロトコルだけ満たす。"""

    def __init__(self, ip: str = "1.2.3.4") -> None:
        self.headers = {"x-forwarded-for": ip}

        class _Client:
            host = ip

        self.client = _Client()


def _make_strict_limiter():
    from app.core.rate_limit import SlidingWindowRateLimiter

    # per_second=1 / per_minute=10 とキツめに絞って、消費されているか判定しやすくする
    return SlidingWindowRateLimiter(per_second=1, per_minute=10, name="test_resolve")


@pytest.mark.asyncio
async def test_cache_hit_does_not_consume_rate_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """成功キャッシュヒットならリミッタを消費しないので、何度叩いても 429 にならない。"""
    _set_affiliate(monkeypatch)
    limiter = _make_strict_limiter()
    req = _FakeRequest()

    call_count = 0

    async def fake_extract(**kw):
        nonlocal call_count
        call_count += 1
        return ResolveResult(
            content_id=kw["content_id"], mp4_url="https://cdn.example/cached.mp4"
        )

    _patch_extract(monkeypatch, fake_extract)

    # 1 回目: extract が走り、リミッタを 1 消費
    r1 = await resolver_client.resolve_mp4("cache001", request=req, limiter=limiter)
    assert r1.mp4_url == "https://cdn.example/cached.mp4"
    assert call_count == 1

    # 2〜5 回目: 短期キャッシュヒットなので extract 不要、かつリミッタも消費しない
    for _ in range(4):
        r = await resolver_client.resolve_mp4(
            "cache001", request=req, limiter=limiter
        )
        assert r.mp4_url == "https://cdn.example/cached.mp4"
    assert call_count == 1
    # per_second=1 なのに 5 回叩いて 429 が出ていない = キャッシュヒットが消費していない


@pytest.mark.asyncio
async def test_inflight_waiters_do_not_consume_rate_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """in-flight デデュープでタダ乗りした waiter はリミッタを消費しない。

    owner だけが 1 回消費。per_second=1 のリミッタでも 10 並列要求が全て成功する。
    """
    _set_affiliate(monkeypatch)
    limiter = _make_strict_limiter()
    req = _FakeRequest()

    call_count = 0
    proceed = asyncio.Event()
    started = asyncio.Event()

    async def fake_extract(**kw):
        nonlocal call_count
        call_count += 1
        started.set()
        await proceed.wait()
        return ResolveResult(
            content_id=kw["content_id"], mp4_url="https://cdn.example/inflight.mp4"
        )

    _patch_extract(monkeypatch, fake_extract)

    # 10 並列で同じ content_id を要求 → 1 つが owner、残りは waiter
    async def call():
        return await resolver_client.resolve_mp4(
            "inflight001", request=req, limiter=limiter
        )

    task_owner = asyncio.create_task(call())
    await started.wait()
    waiters = [asyncio.create_task(call()) for _ in range(9)]
    await asyncio.sleep(0.05)
    proceed.set()

    results = await asyncio.gather(task_owner, *waiters)
    assert all(r.mp4_url == "https://cdn.example/inflight.mp4" for r in results)
    assert call_count == 1  # extract は 1 回だけ
    # per_second=1 だが、owner 1 回しか消費していないので全 10 並列で 429 は出ていない


@pytest.mark.asyncio
async def test_owner_rate_limit_excess_raises_429_and_cleans_inflight(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """owner が連続して上限を超えたら HTTPException(429)。in-flight は残らない。"""
    from fastapi import HTTPException

    _set_affiliate(monkeypatch)
    limiter = _make_strict_limiter()  # per_second=1, per_minute=10
    req = _FakeRequest()

    async def fake_extract(**kw):
        return ResolveResult(
            content_id=kw["content_id"], mp4_url=f"https://cdn.example/{kw['content_id']}.mp4"
        )

    _patch_extract(monkeypatch, fake_extract)

    # 異なる content_id を per_second=1 を超えて連打 → 2 回目で 429
    r1 = await resolver_client.resolve_mp4("ratelimit001", request=req, limiter=limiter)
    assert r1.mp4_url.endswith("ratelimit001.mp4")

    with pytest.raises(HTTPException) as exc:
        await resolver_client.resolve_mp4("ratelimit002", request=req, limiter=limiter)
    assert exc.value.status_code == 429

    # in-flight テーブルに残骸が残っていないことを確認 (次の owner が立てるようにする)
    assert "ratelimit002" not in resolver_client._inflight


@pytest.mark.asyncio
async def test_no_request_skips_rate_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """request=None (jobs / 内部ツール) ならリミッタを完全にスキップ。"""
    _set_affiliate(monkeypatch)

    async def fake_extract(**kw):
        return ResolveResult(
            content_id=kw["content_id"], mp4_url=f"https://cdn.example/{kw['content_id']}.mp4"
        )

    _patch_extract(monkeypatch, fake_extract)

    # 異なる content_id を 5 回連続呼んでも 429 にならない
    for i in range(5):
        r = await resolver_client.resolve_mp4(f"job{i:03d}")
        assert r.mp4_url.endswith(f"job{i:03d}.mp4")
