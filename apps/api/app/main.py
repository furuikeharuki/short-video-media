import logging
from contextlib import asynccontextmanager
from pathlib import Path

from alembic import command
from alembic.config import Config as AlembicConfig
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.api import api_router
from app.core.cache import close_redis
from app.core.config import settings

logger = logging.getLogger(__name__)


def run_migrations() -> None:
    """起動時に alembic upgrade head を実行する。

    Railway のようにコンテナをそのまま起動する環境では
    手動で alembic を実行する手段がないので、
    サービス起動時に自動でマイグレーションを進める。
    """
    # alembic.ini は apps/api 直下にある (Dockerfile で /app に COPY される)
    api_root = Path(__file__).resolve().parent.parent
    cfg_path = api_root / "alembic.ini"
    if not cfg_path.exists():
        logger.warning("alembic.ini not found at %s, skipping migrations", cfg_path)
        return
    try:
        cfg = AlembicConfig(str(cfg_path))
        # script_location を 絶対パスに上書き
        cfg.set_main_option("script_location", str(api_root / "alembic"))
        command.upgrade(cfg, "head")
        logger.info("alembic upgrade head completed")
    except Exception:
        # マイグレーション失敗で API 起動を止めるとダウンするので、
        # エラーをログに出して起動は続行する。
        logger.exception("alembic upgrade head failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    run_migrations()
    yield
    await close_redis()


app = FastAPI(title="ShortVid API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api/v1")
