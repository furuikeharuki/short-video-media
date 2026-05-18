"""resolver の設定。環境変数から Pydantic Settings で読み込む。

環境変数:
    RESOLVER_API_KEY              : POST /resolve の Bearer 認証キー (必須)
    DMM_AFFILIATE_ID              : DMM のアフィリエイト ID (必須)
    RESOLVER_CONCURRENCY          : 同時実行数 (default: 2)
    RESOLVER_NAV_TIMEOUT_MS       : iframe ページ遷移タイムアウト ms (default: 15000)
    RESOLVER_WAIT_VIDEO_TIMEOUT_MS: <video> 要素検出タイムアウト ms (default: 8000)
    RESOLVER_LOG_LEVEL            : ログレベル (default: INFO)
"""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """環境変数から読み込む設定。"""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # 認証
    resolver_api_key: str = ""

    # DMM
    dmm_affiliate_id: str = ""

    # 同時実行制御
    resolver_concurrency: int = 2

    # Playwright タイムアウト
    resolver_nav_timeout_ms: int = 15000
    resolver_wait_video_timeout_ms: int = 8000

    # ログ
    resolver_log_level: str = "INFO"


# シングルトンとして読み込む
settings = Settings()
