from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    DATABASE_URL: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/short_video_media"
    REDIS_URL: str | None = None

    # CORS: カンマ区切りで複数指定可能。例: https://example.com,https://www.example.com
    # 未設定時は開発用にlocalhostのみ許可
    ALLOWED_ORIGINS: list[str] = ["http://localhost:3000", "http://localhost:3001"]

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
