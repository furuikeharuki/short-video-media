"""Redis クライアント管理。

redis パッケージは optional-dependencies (extras: cache) に移してあるため、
未インストール環境でもサーバーは起動できるよう安全に import する。
REDIS_URL 未設定や redis 未インストール時は None を返し、呼び出し側は
fallback (キャッシュを使わずに DB を直叩く) を選ぶ。
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from app.core.config import settings

try:
    import redis.asyncio as aioredis  # type: ignore[import-not-found]
    _REDIS_AVAILABLE = True
except ImportError:
    aioredis = None  # type: ignore[assignment]
    _REDIS_AVAILABLE = False

if TYPE_CHECKING:
    import redis.asyncio as aioredis  # noqa: F811

_redis: Any = None


def get_redis() -> Any:
    """Redis 接続オブジェクトを返す。未接続 / 未インストールなら None。"""
    global _redis
    if _redis is not None:
        return _redis
    if not _REDIS_AVAILABLE or settings.REDIS_URL is None:
        return None
    _redis = aioredis.from_url(  # type: ignore[union-attr]
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
