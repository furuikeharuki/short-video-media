from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.api import api_router
from app.core.cache import close_redis
from app.core.config import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    """アプリのライフサイクル管理。

    マイグレーションは GitHub Actions (.github/workflows/migrate.yml) で
    main にマージされたタイミングで実行する方針。
    アプリ起動時にはマイグレーションを行わない。
    """
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
