"""アプリケーション設定。

本番環境では DATABASE_URL / AUTH_SECRET / APP_USER_SALT が未設定または
"dev-insecure" で始まるデフォルト値のままだと起動を拒否する。

DEPLOY_TARGET 環境変数で配置先 (development / railway / xserver / aws ...)
を明示的に分岐できる。Xserver VPS / AWS など Docker Compose や VPC 内で
Postgres に接続するケースでは、DATABASE_URL に localhost / 127.0.0.1 が
含まれる可能性は基本的にないが、誤接続防止のためのチェックは
DEPLOY_TARGET に応じて挙動を切り替える:

  - xserver / aws / gcp / k8s : DB ホストが Compose サービス名 (db, postgres)
    やプライベート IP / RDS エンドポイントになるため、ローカルホスト指定は
    引き続き拒否する (=本番で誤って 127.0.0.1 を指していたら止める)。
  - railway                   : 従来通り。`railway.internal` 推奨。
  - その他 (development など) : production フラグが立たない限り検査しない。
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

# DEPLOY_TARGET の取り得る値。未知の値も拒否はしないが警告対象。
_KNOWN_DEPLOY_TARGETS = {
    "development",
    "railway",
    "xserver",
    "aws",
    "gcp",
    "k8s",
}


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

    # 配置先 (railway / xserver / aws / gcp / k8s / development)。
    # production の検証ロジックで「ローカルホスト指す DATABASE_URL を許すか」
    # を決めるための分岐に使う。デフォルトは "railway" (歴史的経緯)。
    DEPLOY_TARGET: str = "railway"

    # ─────────────────────────────────────────────
    # イベント API のレート制限 (per IP)
    # ─────────────────────────────────────────────
    # 1 秒あたりの最大イベント数 / 1 分あたりの最大イベント数
    EVENTS_RATE_LIMIT_PER_SECOND: int = 10
    EVENTS_RATE_LIMIT_PER_MINUTE: int = 120

    # ─────────────────────────────────────────────
    # DB 接続プール (asyncpg)
    # ─────────────────────────────────────────────
    # Railway Postgres は idle 接続を約 5 分で切断するため pool_recycle を 300s に。
    # 自前 Postgres / RDS でも 300s 程度なら無害なので統一する。
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
    def deploy_target(self) -> str:
        return (self.DEPLOY_TARGET or "railway").lower()

    @property
    def async_database_url(self) -> str:
        """各種プロバイダの postgresql:// を強制的に asyncpg ダイアレクトに変換"""
        url = self.DATABASE_URL
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql+asyncpg://", 1)
        elif url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
        return url


def _database_url_points_to_localhost(url: str) -> bool:
    """DATABASE_URL がローカルホストを指しているかの簡易判定。

    `postgresql://user:pass@host:5432/db` を雑に分解してホスト部分のみを
    見る。`postgres@localhost`(@ を 2 回含むケース) も最後の `@` までを
    認証情報として扱うため、`rsplit("@", 1)` を使う。
    """
    if "://" not in url:
        return False
    after_scheme = url.split("://", 1)[1]
    if "@" in after_scheme:
        host_part = after_scheme.rsplit("@", 1)[1]
    else:
        host_part = after_scheme
    # host_part: "host:port/db?params" もしくは "host/db"
    host = host_part.split("/", 1)[0].split("?", 1)[0]
    host = host.split(":", 1)[0]
    return host in {"localhost", "127.0.0.1", "::1"}


def _validate_production_settings(s: Settings) -> list[str]:
    """本番起動時に安全でない設定を検出する。"""
    errors: list[str] = []
    if s.AUTH_SECRET == _DEV_AUTH_SECRET or s.AUTH_SECRET.startswith("dev-insecure"):
        errors.append("AUTH_SECRET is using insecure default value")
    if s.APP_USER_SALT == _DEV_USER_SALT or s.APP_USER_SALT.startswith("dev-insecure"):
        errors.append("APP_USER_SALT is using insecure default value")
    if not s.DATABASE_URL:
        errors.append("DATABASE_URL is not set")
    elif _database_url_points_to_localhost(s.DATABASE_URL):
        # production で `db` / `postgres` などの Compose サービス名や
        # プライベート IP / RDS エンドポイントを使うのが正規ルート。
        # 127.0.0.1 / localhost が指定されていたら、ホスト名解決ミスや
        # コピペミスの可能性が高いので拒否する。
        # DEPLOY_TARGET に関係なく一貫して拒否する。
        errors.append(
            f"DATABASE_URL points to localhost in production "
            f"(deploy_target={s.deploy_target}). "
            f"Use a private hostname (compose service name / private IP / "
            f"RDS endpoint / railway.internal) instead."
        )
    if len(s.AUTH_SECRET) < 32:
        errors.append("AUTH_SECRET must be at least 32 characters")
    if len(s.APP_USER_SALT) < 16:
        errors.append("APP_USER_SALT must be at least 16 characters")
    return errors


def _warn_unknown_deploy_target(s: Settings) -> None:
    if s.deploy_target not in _KNOWN_DEPLOY_TARGETS:
        sys.stderr.write(
            f"WARNING: unknown DEPLOY_TARGET={s.deploy_target!r}. "
            f"Known values: {sorted(_KNOWN_DEPLOY_TARGETS)}\n"
        )


settings = Settings()

_warn_unknown_deploy_target(settings)

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
