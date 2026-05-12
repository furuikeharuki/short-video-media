import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.v1.api import api_router

logger = logging.getLogger(__name__)


def run_migrations() -> None:
    try:
        from alembic import command
        from alembic.config import Config
        alembic_cfg = Config("alembic.ini")
        command.upgrade(alembic_cfg, "head")
        logger.info("Migration completed successfully")
    except Exception as e:
        logger.error(f"Migration failed (server will still start): {e}")


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
