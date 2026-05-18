"""FastAPI エントリポイント。

エンドポイント:
    POST /resolve  : MP4 直リンクを抽出して返す (Bearer 認証必須)
    GET  /health   : ヘルスチェック (認証不要)

認証:
    Authorization: Bearer <RESOLVER_API_KEY>

エラーマッピング:
    ResolveNotFound  → 404
    ResolveTimeout   → 504
    ResolveUpstream  → 502
    Auth 失敗        → 401
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field

from .browser_pool import BrowserPool
from .config import settings
from .resolver import (
    ResolveNotFound,
    ResolveTimeout,
    ResolveUpstream,
    extract_mp4_url,
)

logging.basicConfig(
    level=settings.resolver_log_level,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Lifespan: 起動時にブラウザを開き、終了時に閉じる
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    pool = BrowserPool(concurrency=settings.resolver_concurrency)
    await pool.start()
    app.state.browser_pool = pool
    try:
        yield
    finally:
        await pool.stop()


app = FastAPI(
    title="short-video-media resolver",
    description="DMM litevideo iframe から MP4 直リンクを抽出するサービス",
    version="0.1.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


class ResolveRequest(BaseModel):
    content_id: str = Field(..., min_length=1, max_length=64, examples=["1sun00052a"])
    affiliate_id: str | None = Field(
        None,
        description="未指定の場合は環境変数 DMM_AFFILIATE_ID を使用",
        max_length=64,
    )


class ResolveResponse(BaseModel):
    content_id: str
    mp4_url: str


class HealthResponse(BaseModel):
    status: str
    browser_running: bool


# ---------------------------------------------------------------------------
# 認証
# ---------------------------------------------------------------------------


def require_bearer(
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    """Authorization: Bearer <RESOLVER_API_KEY> を検証する。"""
    expected = settings.resolver_api_key
    if not expected:
        # API キー未設定はサーバ側のミスとして 500
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="RESOLVER_API_KEY is not configured",
        )
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing bearer token",
        )
    token = authorization[len("Bearer ") :].strip()
    if token != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid bearer token",
        )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    pool: BrowserPool | None = getattr(app.state, "browser_pool", None)
    return HealthResponse(
        status="ok",
        browser_running=bool(pool and pool.is_running),
    )


@app.post(
    "/resolve",
    response_model=ResolveResponse,
    dependencies=[Depends(require_bearer)],
)
async def resolve(req: ResolveRequest) -> ResolveResponse:
    affiliate_id = req.affiliate_id or settings.dmm_affiliate_id
    if not affiliate_id:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="DMM_AFFILIATE_ID is not configured",
        )

    pool: BrowserPool = app.state.browser_pool
    browser = pool.get_browser()

    async with pool.slot():
        try:
            result = await extract_mp4_url(
                browser,
                content_id=req.content_id,
                affiliate_id=affiliate_id,
                nav_timeout_ms=settings.resolver_nav_timeout_ms,
                wait_video_timeout_ms=settings.resolver_wait_video_timeout_ms,
            )
        except ResolveNotFound as e:
            logger.info("not found: %s", e)
            raise HTTPException(status_code=404, detail=str(e)) from e
        except ResolveTimeout as e:
            logger.warning("timeout: %s", e)
            raise HTTPException(status_code=504, detail=str(e)) from e
        except ResolveUpstream as e:
            logger.warning("upstream: %s", e)
            raise HTTPException(status_code=502, detail=str(e)) from e

    return ResolveResponse(content_id=result.content_id, mp4_url=result.mp4_url)
