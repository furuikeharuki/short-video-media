import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel
from sqlalchemy import select, update
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
# resolve-mp4: サンプル動画 URL を必要に応じて動的に取得する
# ─────────────────────────────────────────────
# 背景:
#   - DMM のサンプル URL は /pv/<token>/<cid>.mp4 形式の動的署名付きに移行しており、
#     サーバーにスタティックに URL を推測させる旧ロジックが使えない。
#   - resolver サービス (Xserver VPS) が Playwright で抽出した URL を返す。
#   - movies.sample_movie_url をキャッシュとして使い、
#     空 / force=true なら resolver を呼んで書き戻す。
# UX:
#   - 初回は DB キャッシュをすぐ返す (高速)。
#   - <video> が再生失敗したら web が force=true でリトライ → 再 resolve。
#   - トークンは 32 日以上有効なので force リトライは長期間に 1 回起きるか起きないか。
class ResolveMp4Response(BaseModel):
    content_id: str | None
    mp4_url: str
    cached: bool  # True = DB キャッシュをそのまま返した / False = resolver を呼んだ (書き戻し済)


@router.get("/movies/{slug}/resolve-mp4", response_model=ResolveMp4Response)
async def resolve_mp4(
    slug: str,
    request: Request,
    force: bool = Query(
        False,
        description="True なら DB キャッシュを無視して resolver を呼んで更新する。"
        "web 側で <video> がエラーになったリトライ時に true を使う。",
    ),
    db: AsyncSession = Depends(get_db),
) -> ResolveMp4Response | Response:
    """作品スラグに対して、実際に再生可能な MP4 URL を返す。

    - force=false (デフォルト): DB の sample_movie_url を返す。空なら resolver を呼ぶ。
    - force=true: 常に resolver を呼ぶ (トークン期限切れをリセットするため)。
    - いずれのケースも、resolver から取得した URL は movies.sample_movie_url に書き戻す。
    """
    # 対象作品を探す。content_id が resolver に必要、sample_movie_url は
    # キャッシュヒット判定に使う。
    row = (
        await db.execute(
            select(
                Movie.id, Movie.content_id, Movie.sample_movie_url
            ).where(Movie.slug == slug)
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Movie not found")
    movie_id, content_id, cached_url = row

    # force でなければ DB キャッシュをそのまま使う。
    if not force and cached_url:
        return ResolveMp4Response(
            content_id=content_id, mp4_url=cached_url, cached=True
        )

    if not content_id:
        # resolver は content_id が必須。content_id が空の作品は抽出できない。
        raise HTTPException(
            status_code=404, detail="content_id missing for this movie"
        )

    # client が既に abort していれば (スクロールで対象外になる、prefetch キャンセル、タブを閉じた等)、
    # resolver を起動せずに 499 で即返して resolver VPS のリソースを節約する。
    # これをしないと、クライアントがキャンセルした prefetch でも Playwright 抽出が走って
    # concurrency 枠を埋めるため、本当に見ているスライドの resolver がキューの末尾に回る。
    # 499 = nginx 互換の「client closed request」。
    if await request.is_disconnected():
        return Response(status_code=499)

    # resolver を呼ぶ。エラーは resolver 側のステータスを透過させる。
    # force=true のときは resolver_client 側の短期キャッシュもスキップして
    # 必ず resolver を叩く (トークン期限切れのリセット用途)。
    # ここでの in-flight デデュープは両ケースとも有効なので、連打しても
    # resolver へは 1 リクエストしか転ばない。
    try:
        mp4_url = await resolver_client.resolve_mp4_url(
            content_id, bypass_cache=force
        )
    except resolver_client.ResolverNotFound as e:
        # 作品が非公開とか。web 側はサムネにフォールバック。
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
    except resolver_client.ResolverUnavailable as e:
        # resolver に繋がらない / 5xx。キャッシュがあればそれでフォールバック。
        if cached_url and not force:
            logger.warning(
                "resolver unavailable, falling back to cached url: %s", e
            )
            return ResolveMp4Response(
                content_id=content_id, mp4_url=cached_url, cached=True
            )
        raise HTTPException(
            status_code=502, detail=f"resolver unavailable: {e}"
        ) from e

    # 成功: DB に書き戻す。同じ URL なら何もしない (UPDATE の where でスキップされる)。
    await db.execute(
        update(Movie)
        .where(Movie.id == movie_id)
        .where(Movie.sample_movie_url.is_distinct_from(mp4_url))
        .values(sample_movie_url=mp4_url)
    )
    await db.commit()

    return ResolveMp4Response(
        content_id=content_id, mp4_url=mp4_url, cached=False
    )


# ─────────────────────────────────────────
# DELETE /movies/{slug}/sample-url: キャッシュされた sample URL を無効化する
# ─────────────────────────────────────────
# 背景:
#   - DB に保存された sample_movie_url がトークン期限切れなどで再生できなく
#     なったときに、web 側が失敗を検知してこのエンドポイントを叩いて DB を
#     NULL に戻しておくと、次回アクセス時は最初から resolver 経由になり、
#     長期的にデータが「自然治癒」していく。
# 仕様:
#   - 対象作品が存在しなければ 404。
#   - sample_movie_url がもともと NULL だったしても 204 を返して OK とする
#     (クライアントが重複して叩いても安全)。
#   - 認証不要 (未ログインユーザーからの報告も受け付ける)。悪意のあるクライアントが
#     連打して NULL に戻しても、次回アクセスで resolver が再取得するだけなので
#     重大な被害はない。レートリミットは今後考慮 (現状 sample-url は rate
#     limiter を付けていない)。
@router.delete("/movies/{slug}/sample-url", status_code=204)
async def invalidate_sample_url(
    slug: str,
    db: AsyncSession = Depends(get_db),
) -> None:
    """DB に保存された sample_movie_url を NULL に戻す。

    <video> レンダリングが失敗したときに web から fire-and-forget で叩かれる。
    """
    row = (
        await db.execute(select(Movie.id).where(Movie.slug == slug))
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Movie not found")
    movie_id = row[0]

    await db.execute(
        update(Movie)
        .where(Movie.id == movie_id)
        .where(Movie.sample_movie_url.is_not(None))
        .values(sample_movie_url=None)
    )
    await db.commit()
    # 204 No Content
    return None
