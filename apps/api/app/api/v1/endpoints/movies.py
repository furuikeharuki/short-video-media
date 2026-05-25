import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

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
#   - resolver_client 側に in-process の in-flight デデュープ + 5 分の短期
#     成功キャッシュがあるので、連打 / バーストは抑制される。
# UX:
#   - 毎回 resolver を呼ぶが、in-process なので 1-2 秒程度。
#   - <video> が再生失敗したら web 側が force=true でリトライ → 短期キャッシュを
#     バイパスして再抽出。
class ResolveMp4Response(BaseModel):
    content_id: str | None
    mp4_url: str


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
) -> ResolveMp4Response | Response:
    """作品スラグに対して、実際に再生可能な MP4 URL を返す。

    DB には MP4 URL を一切保存しない。毎回 resolver_client (in-process httpx)
    で DMM の html5_player ページから抽出する。
    """
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

    try:
        mp4_url = await resolver_client.resolve_mp4_url(
            content_id, bypass_cache=force
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

    return ResolveMp4Response(content_id=content_id, mp4_url=mp4_url)
