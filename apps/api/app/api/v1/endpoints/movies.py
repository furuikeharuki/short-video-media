import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.movie import Movie
from app.db.session import get_db
from app.schemas.movie import MovieDetail
from app.services import movie_video_url_service, resolver_client
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
# resolve-mp4: サンプル動画 URL を DB キャッシュ + 都度フォールバックで返す
# ─────────────────────────────────────────────
# 方針 (ユーザー要望):
#   - 定期ジョブ (sync_video_urls) が低画質・高画質ともに DB に保存する。
#   - 再生時はまず DB 値を返す (resolver を呼ばない → 高画質再生までのレイテンシ削減)。
#   - DB に URL が無い / 再生できない (force=true) ときだけ resolver で抽出し、
#     取得できた新しい URL で DB を更新する。
#
# 期限切れ対策:
#   - DMM トークンは 32 日以上有効。月次ジョブで貼り直すので通常は期限切れしない。
#   - まれに期限切れ等で再生失敗したら web 側が force=true でリトライ →
#     resolver 再抽出 → DB 更新、で自己修復する。
#   - resolver_client 側に in-flight デデュープ + 1 時間の短期成功キャッシュ +
#     force 連打ガードがあるので、DMM への実アクセスは十分に抑制される。
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


def _to_response(
    content_id: str | None, resolved: resolver_client.ResolvedMp4
) -> ResolveMp4Response:
    """正規化済み ResolvedMp4 をレスポンスに変換する (low/high は mp4_url フォールバック)。"""
    low = resolved.low_mp4_url or resolved.mp4_url
    high = resolved.high_mp4_url or resolved.mp4_url
    return ResolveMp4Response(
        content_id=content_id,
        mp4_url=resolved.mp4_url,
        low_mp4_url=low,
        high_mp4_url=high,
    )


@router.get("/movies/{slug}/resolve-mp4", response_model=ResolveMp4Response)
async def resolve_mp4(
    slug: str,
    request: Request,
    force: bool = Query(
        False,
        description="True なら DB キャッシュを短絡せず resolver_client で再抽出し、"
        "取得した URL で DB を更新する。web 側で <video> がエラーになったリトライ時に true を使う。",
    ),
    db: AsyncSession = Depends(get_db),
) -> ResolveMp4Response | Response:
    """作品スラグに対して、実際に再生可能な MP4 URL を返す。

    - DB に URL が保存済みで force=false なら、それを即返す (resolver 非呼び出し)。
    - DB に無い / force=true なら resolver で抽出し、取得した URL で DB を更新する。

    レート制限 (設計メモ):
        429 は endpoint で unconditional に返さず、resolver_client 内部で
        「実際に DMM へ叩く owner」だけに適用する。in-flight デデュープや
        短期成功キャッシュヒットはレート制限を消費しないため、フロントの
        prefetch (+1..+5) + warm (+6..+15) の同時バーストで 429 になりにくい。
    """
    # id / content_id と保存済み MP4 URL 列を取得する。
    row = (
        await db.execute(
            select(
                Movie.id,
                Movie.content_id,
                Movie.sample_mp4_url,
                Movie.sample_low_mp4_url,
                Movie.sample_high_mp4_url,
            ).where(Movie.slug == slug)
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Movie not found")
    movie_id, content_id, s_mp4, s_low, s_high = row

    stored: resolver_client.ResolvedMp4 | None = None
    if s_mp4:
        stored = resolver_client.ResolvedMp4(
            mp4_url=s_mp4,
            low_mp4_url=s_low or s_mp4,
            high_mp4_url=s_high or s_mp4,
        )

    # 通常再生 (force=false): DB に保存済み URL があれば resolver を呼ばずに即返す。
    if not force and stored is not None:
        return _to_response(content_id, stored)

    # ここから先は resolver での抽出が必要。content_id が無いと抽出できない。
    if not content_id:
        # content_id が無くても、DB に保存済み URL があれば最後の手段として返す
        # (通常 content_id 無しの作品に保存済み URL は存在しないが、安全側)。
        if stored is not None:
            return _to_response(content_id, stored)
        raise HTTPException(
            status_code=404, detail="content_id missing for this movie"
        )

    # client が既に abort していれば 499 で即返す (resolver リソース節約)。
    if await request.is_disconnected():
        return Response(status_code=499)

    # 直近に force=true で抽出したばかりなら、連打を抑えるため短期キャッシュ値を使う。
    # web 側の <video> リトライが暴発しても DMM への httpx は最大でも
    # _FORCE_RETRY_MIN_INTERVAL_S に 1 回しか走らない。
    effective_force = force
    if force and resolver_client.should_throttle_force_retry(content_id):
        effective_force = False
    elif force:
        resolver_client.mark_force_retry(content_id)

    try:
        resolved = await resolver_client.resolve_mp4(
            content_id, bypass_cache=effective_force, request=request
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

    # 取得できた新しい URL で DB を更新する (再生時に取得したら DB を更新する要件)。
    # 書き込み失敗は best-effort (再生は継続)。正規化済み結果をレスポンスに使う。
    normalized = await movie_video_url_service.persist_resolved(db, movie_id, resolved)
    return _to_response(content_id, normalized)
