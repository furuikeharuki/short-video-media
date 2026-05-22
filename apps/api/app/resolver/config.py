"""resolver サービス側 (FastAPI app) の設定。

旧 ``apps/resolver/src/config.py`` を ``apps/api`` パッケージへ移動したもの。
``app.core.config.Settings`` とは関心が異なる (resolver は Playwright だけ
気にする / api は DB / 認証 / CORS 等) ため、Settings は分けたままにする。

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


class ResolverServiceSettings(BaseSettings):
    """resolver FastAPI app 用の環境変数。"""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    resolver_api_key: str = ""
    dmm_affiliate_id: str = ""
    resolver_concurrency: int = 2
    resolver_nav_timeout_ms: int = 15000
    resolver_wait_video_timeout_ms: int = 8000
    resolver_log_level: str = "INFO"


settings = ResolverServiceSettings()
