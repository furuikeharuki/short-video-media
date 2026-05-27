import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.rate_limit import (
    SlidingWindowRateLimiter,
    get_resolve_rate_limiter,
)
from app.db.models.movie import Movie
from app.db.session import get_db
from app.schemas.movie import MovieDetail
from app.services import resolver_client
from app.services.movie_service import get_movie_by_slug_service

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/movies/{slug}", response_model=MovieDetail)
async def read_movie(slug: str, db: AsyncSession = Depends(get_db)) -> MovieDetail:
    movie = await get_movie_by_slug_service(db, slug)
    if movie is None:
        raise HTTPException(status_code=404, detail="Movie not found")
    return movie


# ─────────────────────────────────────────────
# resolve-mp4: サンプル動画 URL をその都度動的に取得する
# ─────────────────────────────────────────────
# 背景:
#   - DMM のサンプル URL は /pv/<token>/<cid>.mp4 形式の動的署名付きで、
#     URL を DB にキャッシュしてもトークン期限切れで再生不可になることがあった。
#   - 現行実装は apps/api 内 (httpx) で DMM の html5_player ページから
#     都度抽出するため、トークン期限切れ問題が原理的に発生しない。
#   - resolver_client 側に in-process の in-flight デデュープ + 1 時間の短期
#     成功キャッシュがあるので、連打 / バーストは抑制される。
#   - 共有 httpx.AsyncClient で DMM への接続を keep-alive 維持し、毎回の
#     TLS ハンドシェイクを省く。
# UX:
#   - 毎回 resolver を呼ぶが、in-process なので 1-2 秒程度。
#   - <video> が再生失敗したら web 側が force=true でリトライ → 短期キャッシュを
#     バイパスして再抽出。
class ResolveMp4Response(BaseModel):
    content_id: str | None
    # 既存クライアント (旧 web ビルド・jobs 等) との互換のため、最良の MP4 URL を
    # `mp4_url` に常に返す。これは「低画質ファースト戦略」が無効なケースの
    # フォールバックでもある。
    mp4_url: str
    # 低画質ファースト戦略用の追加候補。
    # - low_mp4_url: 軽量 / 早く再生開始できる候補 (= ファーストペイント用)。
    #   web フロントはまずこの URL で <video> を再生開始する。
    # - high_mp4_url: 高画質候補 (= 最終的に切り替える先)。
    #   裏でロードし、`canplay` 相当に到達したらメイン <video> に差し替える。
    # 低画質と高画質が同じ URL になることもある (single-bitrate)。
    # 抽出に失敗 / 候補が単一しか無い場合は両方とも `mp4_url` と同じ値が入る。
    low_mp4_url: str | None = None
    high_mp4_url: str | None = None


@router.get("/movies/{slug}/resolve-mp4", response_model=ResolveMp4Response)
async def resolve_mp4(
    slug: str,
    request: Request,
    force: bool = Query(
        False,
        description="True なら resolver_client 側の短期成功キャッシュをスキップして"
        "必ず DMM へ再アクセスする。web 側で <video> がエラーになったリトライ時に true を使う。",
    ),
    db: AsyncSession = Depends(get_db),
    limiter: SlidingWindowRateLimiter = Depends(get_resolve_rate_limiter),
) -> ResolveMp4Response | Response:
    """作品スラグに対して、実際に再生可能な MP4 URL を返す。

    DB には MP4 URL を一切保存しない。毎回 resolver_client (in-process httpx)
    で DMM の html5_player ページから抽出する。
    """
    # DMM への外部リクエストを伴うので、過剰な連打を抑える。resolver_client
    # 側に短期成功キャッシュと in-flight デデュープがあるため通常閲覧では
    # 上限に当たらない。
    limiter.check(request)
    # content_id を取得 (resolver に必要)。
    row = (
        await db.execute(
            select(Movie.content_id).where(Movie.slug == slug)
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Movie not found")
    (content_id,) = row

    if not content_id:
        raise HTTPException(
            status_code=404, detail="content_id missing for this movie"
        )

    # client が既に abort していれば 499 で即返す (resolver リソース節約)。
    if await request.is_disconnected():
        return Response(status_code=499)

    # 直近に force=true で抽出したばかりなら、連打を抑えるためキャッシュ値を返す。
    # web 側の <video> リトライが暴発しても DMM への httpx は最大でも
    # _FORCE_RETRY_MIN_INTERVAL_S に 1 回しか走らない。
    effective_force = force
    if force and resolver_client.should_throttle_force_retry(content_id):
        effective_force = False
    elif force:
        resolver_client.mark_force_retry(content_id)

    try:
        resolved = await resolver_client.resolve_mp4(
            content_id, bypass_cache=effective_force
        )
    except resolver_client.ResolverNotFound as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except resolver_client.ResolverTimeout as e:
        raise HTTPException(status_code=504, detail=str(e)) from e
    except resolver_client.ResolverUpstreamError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except resolver_client.ResolverConfigError as e:
        logger.error("resolver not configured: %s", e)
        raise HTTPException(
            status_code=500, detail="resolver service is not configured"
        ) from e

    # low_mp4_url / high_mp4_url が None なら、いずれも primary に揃えて返す。
    # フロント側 (低画質ファースト → 高画質スワップ) が常に両方を見るだけで
    # 良い状態にしておく。同 URL なら web はスワップを発火しない。
    low = resolved.low_mp4_url or resolved.mp4_url
    high = resolved.high_mp4_url or resolved.mp4_url
    return ResolveMp4Response(
        content_id=content_id,
        mp4_url=resolved.mp4_url,
        low_mp4_url=low,
        high_mp4_url=high,
    )
