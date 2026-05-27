"""任意 Sentry 初期化。

`SENTRY_DSN` 環境変数が設定され、かつ `sentry-sdk` がインストールされている
場合にのみ Sentry を有効化する。それ以外では完全 no-op で、テスト・ローカル
開発・依存追加無しの環境を一切壊さない。

import 時は依存を読み込まない (`init_sentry()` を呼んだ瞬間だけ try-import) ため、
sentry-sdk が pyproject.toml に入っていなくてもこのモジュール自体は安全に
import できる。
"""
from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)


def init_sentry() -> bool:
    """Sentry を初期化する。

    Returns:
        True なら実際に初期化された (DSN 設定済み & sdk インストール済み)。
        False なら no-op で終わった (DSN 未設定 / sdk 未インストール)。
    """
    dsn = os.environ.get("SENTRY_DSN", "").strip()
    if not dsn:
        return False

    try:
        import sentry_sdk  # type: ignore[import-not-found]
    except ImportError:
        logger.info(
            "SENTRY_DSN set but sentry-sdk not installed; skipping init"
        )
        return False

    environment = os.environ.get("APP_ENV", "development")
    release = os.environ.get("SENTRY_RELEASE") or os.environ.get(
        "RAILWAY_GIT_COMMIT_SHA"
    )
    traces_sample_rate = _safe_float(os.environ.get("SENTRY_TRACES_SAMPLE_RATE"), 0.0)

    kwargs: dict[str, Any] = {
        "dsn": dsn,
        "environment": environment,
        "traces_sample_rate": traces_sample_rate,
        # PII を送らない (内部 user_id はサーバ側で別途付与する場合のみ)
        "send_default_pii": False,
    }
    if release:
        kwargs["release"] = release
    sentry_sdk.init(**kwargs)
    logger.info("sentry-sdk initialized (env=%s)", environment)
    return True


def _safe_float(value: str | None, default: float) -> float:
    if not value:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default
