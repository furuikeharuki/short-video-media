import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.api import api_router
from app.core.cache import close_redis
from app.core.config import settings
from app.core.request_id import REQUEST_ID_HEADER, RequestIdMiddleware
from app.core.sentry import init_sentry
from app.services import resolve_warm_service
from app.services.resolver_client import (
    shutdown_resolver_http_client,
    startup_resolver_http_client,
)

logger = logging.getLogger(__name__)

# Sentry は import 時に環境変数を見て条件付きで有効化する。
# 未設定 or sentry-sdk 未インストールなら完全 no-op。
init_sentry()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """アプリのライフサイクル管理。

    マイグレーションは GitHub Actions (.github/workflows/migrate.yml) で
    main にマージされたタイミングで実行する方針。
    アプリ起動時にはマイグレーションを行わない。

    DMM への httpx.AsyncClient はプロセスで 1 本だけ持って keep-alive する。
    """
    await startup_resolver_http_client()

    # 事前 resolve (MP4 URL warm) ループ。RESOLVE_WARM_ENABLED=true のときだけ起動。
    # フィードを返すのと同じプロセスで resolver の成功キャッシュを温め、初回再生の
    # resolve 待ちを減らす。Redis 有無に依存しない (in-process キャッシュも温まる)。
    warm_stop: asyncio.Event | None = None
    warm_task: asyncio.Task[None] | None = None
    if settings.RESOLVE_WARM_ENABLED:
        warm_stop = asyncio.Event()
        warm_task = asyncio.create_task(
            resolve_warm_service.warm_resolve_loop(
                interval_s=max(60, settings.RESOLVE_WARM_INTERVAL_SECONDS),
                limit=max(1, settings.RESOLVE_WARM_LIMIT),
                concurrency=max(1, settings.RESOLVE_WARM_CONCURRENCY),
                stop_event=warm_stop,
            )
        )
        logger.info(
            "[resolve_warm] background loop enabled (interval=%ds limit=%d)",
            settings.RESOLVE_WARM_INTERVAL_SECONDS,
            settings.RESOLVE_WARM_LIMIT,
        )

    try:
        yield
    finally:
        if warm_stop is not None:
            warm_stop.set()
        if warm_task is not None:
            warm_task.cancel()
            try:
                await warm_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
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
        "X-Request-Id",
    ],
    # クライアント側 JS から `X-Request-Id` を読めるように expose する。
    expose_headers=["X-Request-Id"],
)

# 全てのリクエストに X-Request-Id を伝搬する。
# 既存ヘッダを優先するため CORS の後段 (= 外側) に置く。
app.add_middleware(RequestIdMiddleware)

app.include_router(api_router, prefix="/api/v1")
