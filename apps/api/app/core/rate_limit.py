"""シンプルな in-memory レートリミッタ。

GitHub Actions 等で複数インスタンスが動く本番では Redis ベースに置き換えるべきだが、
現状の Railway 1 インスタンス構成 + 軽量イベント計測の用途なら十分機能する。

使い方:
    from app.core.rate_limit import EventRateLimiter, get_event_rate_limiter

    @router.post("/events")
    async def create_event(
        request: Request,
        limiter: Annotated[EventRateLimiter, Depends(get_event_rate_limiter)],
    ):
        limiter.check(request)
        ...
"""
from __future__ import annotations

import time
from collections import defaultdict, deque
from threading import Lock
from typing import Deque

from fastapi import HTTPException, Request, status

from app.core.config import settings


class EventRateLimiter:
    """IP ごとに 1 秒・1 分の sliding window でリクエスト数を制限する。"""

    def __init__(self, per_second: int, per_minute: int) -> None:
        self._per_second = per_second
        self._per_minute = per_minute
        # IP -> 過去 60 秒以内のタイムスタンプ (epoch sec, float)
        self._hits: dict[str, Deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def _client_ip(self, request: Request) -> str:
        # Vercel / Railway などのリバースプロキシ越し
        for header in ("x-forwarded-for", "x-real-ip", "cf-connecting-ip"):
            v = request.headers.get(header)
            if v:
                return v.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    def check(self, request: Request) -> None:
        now = time.monotonic()
        ip = self._client_ip(request)
        with self._lock:
            dq = self._hits[ip]
            # 60 秒より古いタイムスタンプを破棄
            while dq and now - dq[0] > 60.0:
                dq.popleft()
            # 1 秒以内のヒット数
            recent_1s = sum(1 for t in dq if now - t <= 1.0)
            if recent_1s >= self._per_second:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="rate limit exceeded (per second)",
                )
            if len(dq) >= self._per_minute:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="rate limit exceeded (per minute)",
                )
            dq.append(now)
            # IP テーブルが肥大化しないよう、空 deque は削除しないがメモリ上限の
            # 心配が出てきたら LRU でラップする
        return None


_event_limiter = EventRateLimiter(
    per_second=settings.EVENTS_RATE_LIMIT_PER_SECOND,
    per_minute=settings.EVENTS_RATE_LIMIT_PER_MINUTE,
)


def get_event_rate_limiter() -> EventRateLimiter:
    return _event_limiter
