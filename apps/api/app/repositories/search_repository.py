from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.movie import Movie
from app.db.models.actress import Actress
from app.db.models.genre import Genre
from app.db.models.series import Series


def _build_keyword_where(query: str):
    """`search_movies` で使う WHERE 条件と必要な subquery を返す。

    total カウント用と items 取得用で重複するロジックをここに集約する。
    """
    q = f"%{query}%"

    actress_sub = (
        select(Movie.id)
        .join(Movie.actresses)
        .where(Actress.name.ilike(q))
    )
    genre_sub = (
        select(Movie.id)
        .join(Movie.genres)
        .where(Genre.name.ilike(q))
    )
    series_sub = (
        select(Movie.id)
        .join(Movie.series)
        .where(Series.name.ilike(q))
    )

    return or_(
        Movie.title.ilike(q),
        Movie.description.ilike(q),
        Movie.director_name.ilike(q),
        Movie.maker_name.ilike(q),
        Movie.label_name.ilike(q),
        Movie.id.in_(actress_sub),
        Movie.id.in_(genre_sub),
        Movie.id.in_(series_sub),
    )


async def search_movies(
    db: AsyncSession,
    query: str,
    *,
    limit: int | None = None,
    offset: int = 0,
) -> tuple[list[Movie], int]:
    """title / description / actress.name / genre.name /
    director_name / maker_name / label_name / series.name の部分一致検索。

    (items, total) を返す。limit=None なら全件取得する。
    """
    where = _build_keyword_where(query)

    # total は item 取得とは別に COUNT(DISTINCT) で取る (ページングしても全体値が欲しい)
    count_stmt = select(func.count(func.distinct(Movie.id))).where(where)
    total = (await db.execute(count_stmt)).scalar_one()

    stmt = (
        select(Movie)
        .where(where)
        .order_by(Movie.title, Movie.id)
    )
    if offset:
        stmt = stmt.offset(offset)
    if limit is not None:
        stmt = stmt.limit(limit)

    result = await db.execute(stmt)
    return list(result.scalars().unique().all()), int(total)


async def search_movies_by_exact_field(
    db: AsyncSession,
    *,
    director: str | None = None,
    maker: str | None = None,
    label: str | None = None,
    series: str | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> tuple[list[Movie], int]:
    """監督 / メーカー / レーベル / シリーズの完全一致検索。

    複数指定時は AND。いずれも None なら空リストと total=0 を返す。
    series は Series.name (Movie.series リレーション) を完全一致で照合する。
    """
    conditions = []
    needs_series_join = False
    if director:
        conditions.append(Movie.director_name == director)
    if maker:
        conditions.append(Movie.maker_name == maker)
    if label:
        conditions.append(Movie.label_name == label)
    if series:
        conditions.append(Series.name == series)
        needs_series_join = True

    if not conditions:
        return [], 0

    # total を取るための COUNT(DISTINCT) クエリ
    count_stmt = select(func.count(func.distinct(Movie.id)))
    if needs_series_join:
        count_stmt = count_stmt.join(Movie.series)
    count_stmt = count_stmt.where(*conditions)
    total = (await db.execute(count_stmt)).scalar_one()

    # items 取得 (delivery_date 降順、同日内は id で安定ソート)
    stmt = select(Movie)
    if needs_series_join:
        stmt = stmt.join(Movie.series)
    stmt = stmt.where(*conditions).order_by(
        Movie.delivery_date.desc().nullslast(), Movie.id
    )
    if offset:
        stmt = stmt.offset(offset)
    if limit is not None:
        stmt = stmt.limit(limit)

    result = await db.execute(stmt)
    return list(result.scalars().unique().all()), int(total)
