from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.api import api_router
from app.core.cache import close_redis
from app.core.config import settings
from app.services.resolver_client import (
    shutdown_resolver_http_client,
    startup_resolver_http_client,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """アプリのライフサイクル管理。

    マイグレーションは GitHub Actions (.github/workflows/migrate.yml) で
    main にマージされたタイミングで実行する方針。
    アプリ起動時にはマイグレーションを行わない。

    DMM への httpx.AsyncClient はプロセスで 1 本だけ持って keep-alive する。
    """
    await startup_resolver_http_client()
    try:
        yield
    finally:
        await shutdown_resolver_http_client()
        await close_redis()


app = FastAPI(title="ShortVid API", lifespan=lifespan)

# CORS。allow_credentials=True と allow_methods=["*"] / allow_headers=["*"] の組み合わせは
# CORS 仕様違反 (ワイルドカードとクレデンシャルは両立しない) なので、
# サービスで実際に使うものだけを明示する。
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Accept",
        "Accept-Language",
        "Authorization",
        "Content-Language",
        "Content-Type",
        "Origin",
        "X-Requested-With",
    ],
)

app.include_router(api_router, prefix="/api/v1")
