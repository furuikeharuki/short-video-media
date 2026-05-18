import logging
import re

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.rate_limit import EventRateLimiter, get_sample_url_rate_limiter
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


# クライアントから「このURLでサンプル動画を読み込めた」と報告されたものを DB に保存する。
# サーバーからは DMM の CDN が GeoIP で 403 を返すため、サーバー侧で URL の有効性を
# 検証できない。代わりに、初回ユーザーがフォールバックで見つけたURLをここに送信
# してもらい、2人目以降はそのURLをそのまま使うようにして遅延を減らす。
class SampleUrlReport(BaseModel):
    sample_movie_url: str = Field(..., max_length=512)


# 不正 URL を DB に保存されないよう、厳密に cc3001.dmm.co.jp の動画パスだけを許可する。
# 許容するパス:
#   - /litevideo/freepv/<a>/<b>/<cid>/<cid>(_mhb_w|mhb|_dmb_w|dmb).mp4  (旧形式・既存作品)
#   - /pv/<token>/<cid>(_mhb_w|mhb|_dmb_w|dmb)?.mp4                    (新形式・動的署名)
# pv パスは Playwright 抽出ジョブとクライアント側 sampleUrlProbe の両方で扱う。
_SAMPLE_URL_RE = re.compile(
    r"^https://cc3001\.dmm\.co\.jp/(?:"
    r"litevideo/freepv/[a-z0-9_]/[a-z0-9_]+/[a-z0-9_]+/[a-z0-9_]+(?:_mhb_w|mhb|_dmb_w|dmb)\.mp4"
    r"|"
    r"pv/[A-Za-z0-9_\-]+/[a-z0-9_]+(?:_mhb_w|mhb|_dmb_w|dmb)?\.mp4"
    r")$"
)


@router.post("/movies/{slug}/sample-url")
async def report_sample_url(
    slug: str,
    payload: SampleUrlReport,
    request: Request,
    db: AsyncSession = Depends(get_db),
    limiter: EventRateLimiter = Depends(get_sample_url_rate_limiter),
) -> dict:
    """クライアントが見つけた有効な sample_movie_url を DB に保存する。

    - URL フォーマットの検証のみで、実际にダウンロード可能かは信頼しない。
      (CDN がサーバーから GeoIP でブロックしているため)
    - 同じ URL だったら何もしない (冪等)。
    - IP ごとにレート制限をかけて、sample_movie_url を連打で上書きされるのを防ぐ。
    """
    limiter.check(request)

    url = payload.sample_movie_url.strip()
    if not _SAMPLE_URL_RE.match(url):
        raise HTTPException(status_code=400, detail="invalid sample_movie_url format")

    result = await db.execute(
        update(Movie)
        .where(Movie.slug == slug)
        .where(Movie.sample_movie_url != url)
        .values(sample_movie_url=url)
    )
    await db.commit()
    return {"ok": True, "updated": result.rowcount or 0}


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
    force: bool = Query(
        False,
        description="True なら DB キャッシュを無視して resolver を呼んで更新する。"
        "web 側で <video> がエラーになったリトライ時に true を使う。",
    ),
    db: AsyncSession = Depends(get_db),
) -> ResolveMp4Response:
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

    # resolver を呼ぶ。エラーは resolver 側のステータスを透過させる。
    try:
        mp4_url = await resolver_client.resolve_mp4_url(content_id)
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
