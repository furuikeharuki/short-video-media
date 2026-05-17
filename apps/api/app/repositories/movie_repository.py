from datetime import date, timedelta

from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.movie import Movie
from app.db.models.genre import Genre
from app.db.models.movie import MovieGenre


async def get_movie_by_slug(db: AsyncSession, slug: str) -> Movie | None:
    result = await db.execute(select(Movie).where(Movie.slug == slug))
    return result.scalar_one_or_none()


async def get_all_movie_ids(db: AsyncSession, genres: list[str] | None = None) -> list[str]:
    """全IDを取得。genresが指定された場合はAND条件で絞り込む。"""
    if genres:
        # AND: 各ジャンルをすべて持つ作品のみ
        query = (
            select(Movie.id)
            .join(Movie.genres)
            .where(Genre.name.in_(genres))
            .group_by(Movie.id)
            .having(func.count(Genre.id.distinct()) == len(genres))
            .order_by(Movie.id)
        )
    else:
        query = select(Movie.id).order_by(Movie.id)
    result = await db.execute(query)
    return list(result.scalars().all())


async def get_movies_by_ids(db: AsyncSession, ids: list[str]) -> dict[str, Movie]:
    """指定IDの作品を一括取得し、id -> Movie の dict で返す。"""
    if not ids:
        return {}
    result = await db.execute(select(Movie).where(Movie.id.in_(ids)))
    movies = result.scalars().all()
    return {m.id: m for m in movies}


async def get_movies_paginated(
    db: AsyncSession,
    offset: int = 0,
    limit: int = 20,
    genres: list[str] | None = None,
) -> tuple[list[Movie], int]:
    if genres:
        # AND: 各ジャンルをすべて持つ作品のみ
        subq = (
            select(Movie.id)
            .join(Movie.genres)
            .where(Genre.name.in_(genres))
            .group_by(Movie.id)
            .having(func.count(Genre.id.distinct()) == len(genres))
            .subquery()
        )
        base_query = select(Movie).where(Movie.id.in_(select(subq)))
        count_query = select(func.count()).select_from(subq)
    else:
        base_query = select(Movie)
        count_query = select(func.count()).select_from(Movie)

    count_result = await db.execute(count_query)
    total = count_result.scalar_one()

    query = base_query.order_by(Movie.id).offset(offset).limit(limit)
    result = await db.execute(query)
    return list(result.scalars().all()), total


async def get_movies_by_slugs_ordered(
    db: AsyncSession,
    slugs: list[str],
) -> list[Movie]:
    """slug リストの順番を保ったまま作品を返す。"""
    if not slugs:
        return []
    result = await db.execute(
        select(Movie).where(Movie.slug.in_(slugs), Movie.is_visible.is_(True))
    )
    movies = list(result.scalars().unique().all())
    order_index = {s: i for i, s in enumerate(slugs)}
    movies.sort(key=lambda m: order_index.get(m.slug, 1 << 30))
    return movies


async def get_new_release_movies(
    db: AsyncSession,
    *,
    on_date: date | None = None,
    fallback_days: int = 7,
    limit: int = 20,
) -> list[Movie]:
    """本日配信開始作品。今日付の primary_date を優先し、
    ゼロ件なら直近 fallback_days 日でフォールバック。"""
    target = on_date or date.today()
    stmt = (
        select(Movie)
        .where(
            Movie.is_visible.is_(True),
            Movie.primary_date == target,
        )
        .order_by(desc(Movie.review_count), Movie.id)
        .limit(limit)
    )
    result = await db.execute(stmt)
    movies = list(result.scalars().unique().all())
    if movies:
        return movies

    # フォールバック: 直近 fallback_days 日の配信を返す
    since = target - timedelta(days=fallback_days)
    stmt2 = (
        select(Movie)
        .where(
            Movie.is_visible.is_(True),
            Movie.primary_date.is_not(None),
            Movie.primary_date >= since,
            Movie.primary_date <= target,
        )
        .order_by(desc(Movie.primary_date), desc(Movie.review_count))
        .limit(limit)
    )
    result2 = await db.execute(stmt2)
    return list(result2.scalars().unique().all())


async def get_movies_by_genre(
    db: AsyncSession,
    *,
    genre_name: str,
    limit: int = 20,
) -> list[Movie]:
    """指定ジャンルを含む作品を人気順 (review_count) で返す。"""
    stmt = (
        select(Movie)
        .join(Movie.genres)
        .where(
            Movie.is_visible.is_(True),
            Genre.name == genre_name,
        )
        .order_by(desc(Movie.review_count), Movie.id)
        .limit(limit)
    )
    result = await db.execute(stmt)
    return list(result.scalars().unique().all())


async def get_fallback_ranking_movies(
    db: AsyncSession,
    *,
    limit: int = 20,
    window_days: int | None = None,
) -> list[Movie]:
    """イベントデータが不足しているときの代替ランキング。

    window_days を指定すると、直近 N 日に配信開始 (primary_date) された
    作品の中で review_count 降順を返す。
    ヒット件数が limit に満たない場合は、全体の review_count 降順で補充する。
    """
    movies: list[Movie] = []
    seen_ids: set[str] = set()

    if window_days is not None and window_days > 0:
        since = date.today() - timedelta(days=window_days)
        stmt_window = (
            select(Movie)
            .where(
                Movie.is_visible.is_(True),
                Movie.primary_date.is_not(None),
                Movie.primary_date >= since,
            )
            .order_by(desc(Movie.review_count), desc(Movie.review_average), Movie.id)
            .limit(limit)
        )
        result = await db.execute(stmt_window)
        for m in result.scalars().unique().all():
            if m.id not in seen_ids:
                movies.append(m)
                seen_ids.add(m.id)

    if len(movies) >= limit:
        return movies[:limit]

    # 補充: 全体の review_count 降順
    stmt = (
        select(Movie)
        .where(Movie.is_visible.is_(True))
        .order_by(desc(Movie.review_count), desc(Movie.review_average), Movie.id)
        .limit(limit * 2)
    )
    result = await db.execute(stmt)
    for m in result.scalars().unique().all():
        if len(movies) >= limit:
            break
        if m.id in seen_ids:
            continue
        movies.append(m)
        seen_ids.add(m.id)
    return movies[:limit]


async def get_top_genres_by_movie_count(
    db: AsyncSession,
    *,
    limit: int = 10,
    exclude: set[str] | None = None,
) -> list[str]:
    """作品数の多い genre 名を上から limit 件返す。技術タグ除外。"""
    stmt = (
        select(Genre.name, func.count(MovieGenre.movie_id).label("c"))
        .join(MovieGenre, MovieGenre.genre_id == Genre.id)
        .group_by(Genre.name)
        .order_by(desc("c"))
        .limit(limit * 3)  # 除外後 limit 件残る余裕
    )
    result = await db.execute(stmt)
    out: list[str] = []
    for name, _ in result.all():
        if exclude and name in exclude:
            continue
        out.append(name)
        if len(out) >= limit:
            break
    return out
