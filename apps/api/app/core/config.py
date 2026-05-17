from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    DATABASE_URL: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/short_video_media"
    REDIS_URL: str | None = None

    # CORS許可Origin。カンマ区切りで複数指定可能。
    # 例: ALLOWED_ORIGINS=http://localhost:3000,https://example.com
    ALLOWED_ORIGINS: str = "http://localhost:3000,http://localhost:3001"

    # 認証関連。Next.js 側 (auth.js) と同じ AUTH_SECRET / APP_USER_SALT を共有する。
    # AUTH_SECRET: HS256 JWT 署名キー (32 byte 以上推奨)
    # APP_USER_SALT: provider+sub を SHA-256 する際のソルト (サービス一意のランダム文字列)
    # JWT_AUDIENCE: トークンの aud クレーム
    # JWT_EXPIRES_SECONDS: 有効期限 (デフォルト 30 日)
    AUTH_SECRET: str = "dev-insecure-auth-secret-change-in-production-please"
    APP_USER_SALT: str = "dev-insecure-user-salt-change-in-production"
    JWT_AUDIENCE: str = "short-video-media"
    JWT_EXPIRES_SECONDS: int = 60 * 60 * 24 * 30  # 30 日

    @property
    def allowed_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.ALLOWED_ORIGINS.split(",") if origin.strip()]

    @property
    def async_database_url(self) -> str:
        """Railway 等が返す postgresql:// を強制的に asyncpg ダイアレクトに変換"""
        url = self.DATABASE_URL
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql+asyncpg://", 1)
        elif url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
        return url


settings = Settings()
