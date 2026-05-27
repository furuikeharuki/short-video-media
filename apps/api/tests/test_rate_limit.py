"""SlidingWindowRateLimiter (旧 EventRateLimiter) のユニットテスト。

特に IP バケットが古くなったら掃除されてメモリリークしないことを確認する。
"""
from __future__ import annotations

import time
from typing import Iterator

import pytest
from fastapi import HTTPException

from app.core.rate_limit import SlidingWindowRateLimiter


class _FakeRequest:
    """check() が呼ぶ headers / client.host だけを持つ最低限のスタブ。"""

    def __init__(self, ip: str) -> None:
        self.headers: dict[str, str] = {"x-forwarded-for": ip}
        self.client = None  # 使われない (x-forwarded-for を優先するため)


def test_per_second_limit_raises_429() -> None:
    limiter = SlidingWindowRateLimiter(per_second=2, per_minute=100, name="t")
    req = _FakeRequest("1.1.1.1")
    limiter.check(req)
    limiter.check(req)
    with pytest.raises(HTTPException) as exc:
        limiter.check(req)
    assert exc.value.status_code == 429


def test_per_minute_limit_raises_429() -> None:
    limiter = SlidingWindowRateLimiter(per_second=1000, per_minute=3, name="t")
    req = _FakeRequest("2.2.2.2")
    limiter.check(req)
    limiter.check(req)
    limiter.check(req)
    with pytest.raises(HTTPException) as exc:
        limiter.check(req)
    assert exc.value.status_code == 429


def test_different_ips_are_isolated() -> None:
    limiter = SlidingWindowRateLimiter(per_second=1, per_minute=1, name="t")
    a = _FakeRequest("3.3.3.3")
    b = _FakeRequest("4.4.4.4")
    limiter.check(a)
    # b は別 IP なので通る
    limiter.check(b)
    # a を再度叩くと 429
    with pytest.raises(HTTPException):
        limiter.check(a)


def test_sweep_removes_stale_buckets() -> None:
    """force_sweep を呼んだとき、window を過ぎた IP バケットが削除される。"""
    limiter = SlidingWindowRateLimiter(
        per_second=1000,
        per_minute=1000,
        name="t",
        window_sec=0.01,  # 10ms にして短時間で stale にする
    )
    # 10 IP からアクセス
    for i in range(10):
        limiter.check(_FakeRequest(f"10.0.0.{i}"))
    assert limiter._bucket_count_for_tests() == 10
    # window を超える時間を待つ
    time.sleep(0.05)
    # 手動 sweep を呼ぶと古いバケットが全部消える
    limiter._force_sweep_for_tests()
    assert limiter._bucket_count_for_tests() == 0


def test_periodic_sweep_runs_during_check() -> None:
    """check が一定回数呼ばれるたびに自動 sweep が走る。"""
    limiter = SlidingWindowRateLimiter(
        per_second=10000,
        per_minute=10000,
        name="t",
        window_sec=0.01,
    )
    limiter._SWEEP_INTERVAL_CHECKS = 8  # テスト用に短くする
    # 4 IP それぞれ 1 回ずつ
    for i in range(4):
        limiter.check(_FakeRequest(f"11.0.0.{i}"))
    # window を超える
    time.sleep(0.05)
    # 同じ IP で連打して sweep をトリガする
    for _ in range(8):
        limiter.check(_FakeRequest("12.0.0.1"))
    # 古いバケット (11.0.0.*) は掃除されているはず
    count = limiter._bucket_count_for_tests()
    # 残るのは 12.0.0.1 のみ (1 件)
    assert count == 1


def test_bucket_does_not_grow_unboundedly_with_unique_ips() -> None:
    """大量の異なる IP を入れても、sweep が走れば bucket が減る。"""
    limiter = SlidingWindowRateLimiter(
        per_second=10000,
        per_minute=10000,
        name="t",
        window_sec=0.005,
    )
    for i in range(1000):
        limiter.check(_FakeRequest(f"172.16.{i // 256}.{i % 256}"))
    # 一度全部 stale になるまで待つ
    time.sleep(0.05)
    limiter._force_sweep_for_tests()
    # sweep 後は 0
    assert limiter._bucket_count_for_tests() == 0
