from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.actress import Actress
from app.db.models.genre import Genre
from app.db.models.movie import Movie, MovieActress, MovieGenre
from app.db.session import get_db

router = APIRouter(prefix="/sitemap")


class MovieSitemapEntry(BaseModel):
    slug: str
    last_modified: str | None


class ActressSitemapEntry(BaseModel):
    name: str
    last_modified: str | None


class GenreSitemapEntry(BaseModel):
    name: str
    last_modified: str | None


class SitemapUrls(BaseModel):
    movies: list[MovieSitemapEntry]
    actresses: list[ActressSitemapEntry]
    genres: list[GenreSitemapEntry] = []


# Google が 1 つの sitemap.xml に許す URL 数の上限は 50,000。
# 静的 URL 数十件 + 余裕を見て、本数の多い movies を 40,000、
# actresses を 9,000 までに制限する (合計 5 万を超えない)。
DEFAULT_MOVIE_LIMIT = 40_000
DEFAULT_ACTRESS_LIMIT = 9_000
# ジャンルは数百件程度。集約ページ (/genres/[genre]) 用に全件返して問題ない。
DEFAULT_GENRE_LIMIT = 2_000


@router.get("/urls", response_model=SitemapUrls)
async def get_sitemap_urls(
    movie_limit: int = Query(DEFAULT_MOVIE_LIMIT, ge=1, le=50_000),
    actress_limit: int = Query(DEFAULT_ACTRESS_LIMIT, ge=1, le=50_000),
    genre_limit: int = Query(DEFAULT_GENRE_LIMIT, ge=1, le=50_000),
    db: AsyncSession = Depends(get_db),
) -> SitemapUrls:
    """sitemap.xml 生成用の URL 一覧を返す。

    - movies: is_visible=True の作品 slug を primary_date 降順で返す
    - actresses: 出演作品が 1 件でもある女優名を、最新出演日降順で返す
    - genres: 公開作品が 1 件以上あるジャンル名を、最新作品日降順で返す
    """
    # 公開作品の slug。lastmod は primary_date を採用 (配信開始日 or 発売日)。
    movie_stmt = (
        select(Movie.slug, Movie.primary_date)
        .where(Movie.is_visible.is_(True))
        .order_by(desc(Movie.primary_date), Movie.id)
        .limit(movie_limit)
    )
    movie_rows = (await db.execute(movie_stmt)).all()
    movies = [
        MovieSitemapEntry(
            slug=slug,
            last_modified=str(primary_date) if primary_date else None,
        )
        for slug, primary_date in movie_rows
    ]

    # 出演作品が 1 件以上ある女優のみを対象にする (孤児女優を sitemap から外す)。
    # lastmod は出演作品の最新 primary_date。
    latest_date = func.max(Movie.primary_date).label("latest_date")
    actress_stmt = (
        select(Actress.name, latest_date)
        .join(MovieActress, MovieActress.actress_id == Actress.id)
        .join(Movie, Movie.id == MovieActress.movie_id)
        .where(Movie.is_visible.is_(True))
        .group_by(Actress.id, Actress.name)
        .order_by(desc(latest_date), Actress.id)
        .limit(actress_limit)
    )
    actresses = [
        ActressSitemapEntry(
            name=name,
            last_modified=str(latest) if latest else None,
        )
        for name, latest in (await db.execute(actress_stmt)).all()
    ]

    # 公開作品が 1 件以上あるジャンルのみを対象にする (空ジャンルを sitemap から外す)。
    # lastmod はそのジャンルに紐づく公開作品の最新 primary_date。
    genre_latest = func.max(Movie.primary_date).label("genre_latest")
    genre_stmt = (
        select(Genre.name, genre_latest)
        .join(MovieGenre, MovieGenre.genre_id == Genre.id)
        .join(Movie, Movie.id == MovieGenre.movie_id)
        .where(Movie.is_visible.is_(True))
        .group_by(Genre.id, Genre.name)
        .order_by(desc(genre_latest), Genre.id)
        .limit(genre_limit)
    )
    genres = [
        GenreSitemapEntry(
            name=name,
            last_modified=str(latest) if latest else None,
        )
        for name, latest in (await db.execute(genre_stmt)).all()
    ]

    return SitemapUrls(movies=movies, actresses=actresses, genres=genres)
