"""アプリケーション設定。

本番環境では DATABASE_URL / AUTH_SECRET / APP_USER_SALT が未設定または
"dev-insecure" で始まるデフォルト値のままだと起動を拒否する。
"""

from __future__ import annotations

import os
import sys

from pydantic_settings import BaseSettings, SettingsConfigDict


# 開発環境用のダミー値。これらが本番で使われたら確実にエラーを出す。
_DEV_AUTH_SECRET = "dev-insecure-auth-secret-change-in-production-please"
_DEV_USER_SALT = "dev-insecure-user-salt-change-in-production"
# DATABASE_URL にはデフォルトを与えない。本番 / 開発のどちらでも明示的に
# 設定させることで、予期せぬ localhost に接続してデータを壊す事故を防ぐ。


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # 本番環境では必ず環境変数で上書きが必要。
    # ローカル開発でも `cp infra/docker/.env.example infra/docker/.env` で
    # 自分用の値に置き換えること。
    DATABASE_URL: str = ""
    REDIS_URL: str | None = None

    # CORS許可Origin。カンマ区切りで複数指定可能。
    # 例: ALLOWED_ORIGINS=http://localhost:3000,https://example.com
    ALLOWED_ORIGINS: str = "http://localhost:3000,http://localhost:3001"

    # 認証関連。Next.js 側 (auth.js) と同じ AUTH_SECRET / APP_USER_SALT を共有する。
    # AUTH_SECRET: HS256 JWT 署名キー (32 byte 以上推奨)
    # APP_USER_SALT: provider+sub を SHA-256 する際のソルト (サービス一意のランダム文字列)
    # JWT_AUDIENCE: トークンの aud クレーム
    # JWT_EXPIRES_SECONDS: 有効期限 (デフォルト 30 日)
    AUTH_SECRET: str = _DEV_AUTH_SECRET
    APP_USER_SALT: str = _DEV_USER_SALT
    JWT_AUDIENCE: str = "short-video-media"
    JWT_EXPIRES_SECONDS: int = 60 * 60 * 24 * 30  # 30 日

    # 環境判定。"production" のときに insecure デフォルト検出で起動を止める。
    APP_ENV: str = "development"

    # ─────────────────────────────────────────────
    # イベント API のレート制限 (per IP)
    # ─────────────────────────────────────────────
    # 1 秒あたりの最大イベント数 / 1 分あたりの最大イベント数
    EVENTS_RATE_LIMIT_PER_SECOND: int = 10
    EVENTS_RATE_LIMIT_PER_MINUTE: int = 120

    # sample-url 報告 API のレート制限 (per IP)。
    # 通常は 1 ユーザー 1 作品につき 1 回だけ呼ばれるため、events より厳しめに絞る。
    SAMPLE_URL_RATE_LIMIT_PER_SECOND: int = 2
    SAMPLE_URL_RATE_LIMIT_PER_MINUTE: int = 30

    # ─────────────────────────────────────────────
    # Resolver サービス (Xserver VPS 上の apps/resolver) 連携
    # ─────────────────────────────────────────────
    # MP4 URL 解決サービスのベース URL (例: http://162.43.24.128)。
    # 末尾スラッシュは付けても付けなくても良い。
    RESOLVER_BASE_URL: str = ""
    # resolver の Bearer 認証用 API キー。VPS の .env と同じ値を入れる。
    RESOLVER_API_KEY: str = ""
    # resolver への HTTP タイムアウト (ミリ秒)。Playwright 抽出は通常 8 秒程度。
    # ナビ 15s + 描画 8s + マージン分で 25 秒。Railway の 30s 上限を超えないこと。
    RESOLVER_TIMEOUT_MS: int = 25000

    # ─────────────────────────────────────────────
    # DB 接続プール (asyncpg)
    # ─────────────────────────────────────────────
    # Railway Postgres は idle 接続を約 5 分で切断するため pool_recycle を 300s に。
    DB_POOL_SIZE: int = 10
    DB_MAX_OVERFLOW: int = 20
    DB_POOL_RECYCLE: int = 300
    DB_POOL_PRE_PING: bool = True

    @property
    def allowed_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.ALLOWED_ORIGINS.split(",") if origin.strip()]

    @property
    def is_production(self) -> bool:
        return self.APP_ENV.lower() in ("production", "prod")

    @property
    def async_database_url(self) -> str:
        """Railway 等が返す postgresql:// を強制的に asyncpg ダイアレクトに変換"""
        url = self.DATABASE_URL
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql+asyncpg://", 1)
        elif url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
        return url


def _validate_production_settings(s: Settings) -> list[str]:
    """本番起動時に安全でない設定を検出する。"""
    errors: list[str] = []
    if s.AUTH_SECRET == _DEV_AUTH_SECRET or s.AUTH_SECRET.startswith("dev-insecure"):
        errors.append("AUTH_SECRET is using insecure default value")
    if s.APP_USER_SALT == _DEV_USER_SALT or s.APP_USER_SALT.startswith("dev-insecure"):
        errors.append("APP_USER_SALT is using insecure default value")
    if not s.DATABASE_URL:
        errors.append("DATABASE_URL is not set")
    elif "localhost" in s.DATABASE_URL or "127.0.0.1" in s.DATABASE_URL:
        errors.append("DATABASE_URL points to localhost in production")
    if len(s.AUTH_SECRET) < 32:
        errors.append("AUTH_SECRET must be at least 32 characters")
    if len(s.APP_USER_SALT) < 16:
        errors.append("APP_USER_SALT must be at least 16 characters")
    return errors


settings = Settings()

if settings.is_production:
    _errors = _validate_production_settings(settings)
    if _errors:
        # pytest 経由などでも気付けるよう stderr に明確に出す
        sys.stderr.write(
            "ERROR: insecure or missing settings detected in production:\n"
        )
        for _e in _errors:
            sys.stderr.write(f"  - {_e}\n")
        raise RuntimeError(
            "Refusing to start with insecure production settings: "
            + ", ".join(_errors)
        )
