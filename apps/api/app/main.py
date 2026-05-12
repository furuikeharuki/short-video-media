import logging
import signal
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.v1.api import api_router

logger = logging.getLogger(__name__)


def _timeout_handler(signum, frame):
    raise TimeoutError("Migration timed out after 30 seconds")


def run_migrations() -> None:
    try:
        signal.signal(signal.SIGALRM, _timeout_handler)
        signal.alarm(30)  # 30秒で強制タイムアウト
        from alembic import command
        from alembic.config import Config
        alembic_cfg = Config("alembic.ini")
        command.upgrade(alembic_cfg, "head")
        signal.alarm(0)  # タイマーキャンセル
        logger.info("Migration completed successfully")
    except TimeoutError as e:
        logger.error(f"Migration timed out: {e}")
    except Exception as e:
        logger.error(f"Migration failed (server will still start): {e}")
    finally:
        signal.alarm(0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    run_migrations()
    yield


app = FastAPI(
    title="Short Video Media API",
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(api_router, prefix="/api/v1")


@app.get("/")
def root():
    return {"message": "Short Video Media API"}
