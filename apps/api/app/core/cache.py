"""Redis クライアント管理。REDIS_URL 未設定の場合は None を返す。"""
from __future__ import annotations

import redis.asyncio as aioredis

from app.core.config import settings

_redis: aioredis.Redis | None = None


def get_redis() -> aioredis.Redis | None:
    """Redis 接続オブジェクトを返す。未接続なら None。"""
    global _redis
    if _redis is not None:
        return _redis
    if settings.REDIS_URL is None:
        return None
    _redis = aioredis.from_url(
        settings.REDIS_URL,
        encoding="utf-8",
        decode_responses=True,
    )
    return _redis


async def close_redis() -> None:
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None
