import re

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.rate_limit import EventRateLimiter, get_sample_url_rate_limiter
from app.db.models.movie import Movie
from app.db.session import get_db
from app.schemas.movie import MovieDetail
from app.services.movie_service import get_movie_by_slug_service

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
