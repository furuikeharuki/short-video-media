from __future__ import annotations

from datetime import date
from typing import Literal

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.actress import Actress
from app.db.models.event import Event
from app.db.models.genre import Genre
from app.db.models.movie import Movie, MovieActress, MovieGenre
from app.db.models.series import Series
from app.db.models.user import Bookmark


SortKey = Literal["new", "popular", "rating", "views", "bookmarks"]
SuggestField = Literal["actress", "series", "director", "maker", "label", "genre"]


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


# ----------------------------------------------------------------------
# Advanced search
# ----------------------------------------------------------------------


def _ng_word_condition(word: str):
    """単一 NG ワードについて「どこにも含まれてはいけない」条件を返す。

    タイトル / 説明 / 監督 / メーカー / レーベル / 女優名 / ジャンル名 / シリーズ名の
    いずれにも部分一致しないこと (case-insensitive)。NULL を含むカラムは
    coalesce で空文字に倒して安全に ilike できるようにする。
    """
    pat = f"%{word}%"
    ng_actress_sub = (
        select(MovieActress.movie_id)
        .join(Actress, Actress.id == MovieActress.actress_id)
        .where(Actress.name.ilike(pat))
    )
    ng_genre_sub = (
        select(MovieGenre.movie_id)
        .join(Genre, Genre.id == MovieGenre.genre_id)
        .where(Genre.name.ilike(pat))
    )
    ng_series_sub = select(Series.id).where(Series.name.ilike(pat))

    return and_(
        ~func.coalesce(Movie.title, "").ilike(pat),
        ~func.coalesce(Movie.description, "").ilike(pat),
        ~func.coalesce(Movie.director_name, "").ilike(pat),
        ~func.coalesce(Movie.maker_name, "").ilike(pat),
        ~func.coalesce(Movie.label_name, "").ilike(pat),
        ~Movie.id.in_(ng_actress_sub),
        ~Movie.id.in_(ng_genre_sub),
        # series_id が NULL の作品は OK (シリーズ無しなので除外対象になり得ない)
        or_(Movie.series_id.is_(None), ~Movie.series_id.in_(ng_series_sub)),
    )


def _build_advanced_conditions(
    *,
    q: str | None,
    genres: list[str],
    actresses: list[str],
    series_list: list[str],
    directors: list[str],
    makers: list[str],
    labels: list[str],
    date_from: date | None,
    date_to: date | None,
    ng_words: list[str],
) -> list:
    """advanced_search の WHERE 条件を組み立てる。"""
    conditions: list = [Movie.is_visible.is_(True)]

    # キーワード (既存の全文部分一致と同じロジックを AND で合流)
    if q:
        conditions.append(_build_keyword_where(q))

    # ジャンル AND: 指定された全ジャンルを含む作品のみ。
    # HAVING COUNT(DISTINCT genre_name) = N で「N 個全部マッチした movie_id」を出す。
    if genres:
        sub = (
            select(MovieGenre.movie_id)
            .join(Genre, Genre.id == MovieGenre.genre_id)
            .where(Genre.name.in_(genres))
            .group_by(MovieGenre.movie_id)
            .having(func.count(func.distinct(Genre.name)) == len(genres))
        )
        conditions.append(Movie.id.in_(sub))

    # 女優 AND: 同じ手で。
    if actresses:
        sub = (
            select(MovieActress.movie_id)
            .join(Actress, Actress.id == MovieActress.actress_id)
            .where(Actress.name.in_(actresses))
            .group_by(MovieActress.movie_id)
            .having(func.count(func.distinct(Actress.name)) == len(actresses))
        )
        conditions.append(Movie.id.in_(sub))

    # シリーズ OR: 作品は最大 1 シリーズしか持たないので AND の意味がなく OR。
    if series_list:
        conditions.append(
            Movie.series_id.in_(select(Series.id).where(Series.name.in_(series_list)))
        )

    # 監督 / メーカー / レーベル OR: フィールド直値の IN で十分。
    if directors:
        conditions.append(Movie.director_name.in_(directors))
    if makers:
        conditions.append(Movie.maker_name.in_(makers))
    if labels:
        conditions.append(Movie.label_name.in_(labels))

    # 配信日 (primary_date) 範囲
    if date_from is not None:
        conditions.append(Movie.primary_date >= date_from)
    if date_to is not None:
        conditions.append(Movie.primary_date <= date_to)

    # NG ワード: 1 ワード = 1 AND 条件 (すべて条件をクリアしないと残らない)
    for w in ng_words:
        if not w:
            continue
        conditions.append(_ng_word_condition(w))

    return conditions


async def advanced_search_movies(
    db: AsyncSession,
    *,
    q: str | None = None,
    genres: list[str] | None = None,
    actresses: list[str] | None = None,
    series_list: list[str] | None = None,
    directors: list[str] | None = None,
    makers: list[str] | None = None,
    labels: list[str] | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    ng_words: list[str] | None = None,
    sort: SortKey = "new",
    limit: int | None = None,
    offset: int = 0,
) -> tuple[list[Movie], int]:
    """詳細絞り込み検索。

    引数は全て optional。指定があれば AND で重ねていく。
    sort は "new" / "popular" / "rating" / "views" / "bookmarks" のいずれか。
    views と bookmarks はそれぞれ events / bookmarks テーブルから集計サブクエリを
    LEFT JOIN して、COALESCE(count, 0) でソートする (作品ごとの実績が 0 でも結果には残す)。
    """
    conditions = _build_advanced_conditions(
        q=q,
        genres=genres or [],
        actresses=actresses or [],
        series_list=series_list or [],
        directors=directors or [],
        makers=makers or [],
        labels=labels or [],
        date_from=date_from,
        date_to=date_to,
        ng_words=ng_words or [],
    )

    # total は items 取得とは別クエリで先に取る (next_cursor 判定に使う)
    count_stmt = select(func.count(func.distinct(Movie.id))).where(*conditions)
    total = (await db.execute(count_stmt)).scalar_one()

    # items: ソート種別に応じてサブクエリを組み立てる
    stmt = select(Movie).where(*conditions)

    if sort == "new":
        stmt = stmt.order_by(
            Movie.primary_date.desc().nullslast(), Movie.id.asc()
        )
    elif sort == "popular":
        stmt = stmt.order_by(
            Movie.review_count.desc().nullslast(),
            Movie.primary_date.desc().nullslast(),
            Movie.id.asc(),
        )
    elif sort == "rating":
        stmt = stmt.order_by(
            Movie.review_average.desc().nullslast(),
            Movie.review_count.desc().nullslast(),
            Movie.id.asc(),
        )
    elif sort == "views":
        # events テーブルから event_type="view" を slug で集計してくっつける。
        # slug は Movie.slug と一致。COALESCE で集計のない作品も 0 として残す。
        views_sub = (
            select(
                Event.slug.label("slug"),
                func.count(Event.id).label("view_count"),
            )
            .where(Event.event_type == "view")
            .group_by(Event.slug)
            .subquery()
        )
        stmt = stmt.outerjoin(views_sub, views_sub.c.slug == Movie.slug).order_by(
            func.coalesce(views_sub.c.view_count, 0).desc(),
            Movie.primary_date.desc().nullslast(),
            Movie.id.asc(),
        )
    elif sort == "bookmarks":
        bookmarks_sub = (
            select(
                Bookmark.movie_id.label("movie_id"),
                func.count().label("bm_count"),
            )
            .group_by(Bookmark.movie_id)
            .subquery()
        )
        stmt = stmt.outerjoin(
            bookmarks_sub, bookmarks_sub.c.movie_id == Movie.id
        ).order_by(
            func.coalesce(bookmarks_sub.c.bm_count, 0).desc(),
            Movie.primary_date.desc().nullslast(),
            Movie.id.asc(),
        )
    else:
        # 想定外: new 扱いにフォールバック (型レベルでは Literal で塞いでいるが念のため)
        stmt = stmt.order_by(
            Movie.primary_date.desc().nullslast(), Movie.id.asc()
        )

    if offset:
        stmt = stmt.offset(offset)
    if limit is not None:
        stmt = stmt.limit(limit)

    result = await db.execute(stmt)
    return list(result.scalars().unique().all()), int(total)


# ----------------------------------------------------------------------
# Suggest (詳細検索パネルの入力サジェスト用)
# ----------------------------------------------------------------------


async def suggest_field_values(
    db: AsyncSession,
    *,
    field: SuggestField,
    q: str = "",
    limit: int = 10,
) -> list[str]:
    """指定フィールドの値を「その値を持つ可視作品数の多い順」で返す。

    詳細検索パネルのテキスト入力時のサジェスト用。NULL/空文字は除外し、
    is_visible=False の作品は集計から外す (検索結果と整合させる)。

    マッピング:
      - actress / genre: M:N (movie_actresses / movie_genres) を JOIN し、
        Movie.is_visible=True で絞ってから COUNT(DISTINCT Movie.id)
      - series: Series ←→ Movie の 1:M。Series.name を返し、
        紐づく可視作品数で並べる
      - director / maker / label: Movie のカラム直値。値で GROUP BY して
        COUNT(DISTINCT Movie.id)
    """
    pattern = f"%{q}%" if q else None

    if field == "actress":
        name_col = Actress.name
        stmt = (
            select(name_col, func.count(func.distinct(Movie.id)).label("cnt"))
            .select_from(Actress)
            .join(MovieActress, MovieActress.actress_id == Actress.id)
            .join(Movie, Movie.id == MovieActress.movie_id)
            .where(Movie.is_visible.is_(True), name_col.is_not(None), name_col != "")
        )
    elif field == "genre":
        name_col = Genre.name
        stmt = (
            select(name_col, func.count(func.distinct(Movie.id)).label("cnt"))
            .select_from(Genre)
            .join(MovieGenre, MovieGenre.genre_id == Genre.id)
            .join(Movie, Movie.id == MovieGenre.movie_id)
            .where(Movie.is_visible.is_(True), name_col.is_not(None), name_col != "")
        )
    elif field == "series":
        name_col = Series.name
        # Movie.series_id FK 経由。可視作品を持たないシリーズは出さない (INNER JOIN)
        stmt = (
            select(name_col, func.count(func.distinct(Movie.id)).label("cnt"))
            .select_from(Series)
            .join(Movie, Movie.series_id == Series.id)
            .where(Movie.is_visible.is_(True), name_col.is_not(None), name_col != "")
        )
    elif field == "director":
        name_col = Movie.director_name
        stmt = select(name_col, func.count(func.distinct(Movie.id)).label("cnt")).where(
            Movie.is_visible.is_(True), name_col.is_not(None), name_col != ""
        )
    elif field == "maker":
        name_col = Movie.maker_name
        stmt = select(name_col, func.count(func.distinct(Movie.id)).label("cnt")).where(
            Movie.is_visible.is_(True), name_col.is_not(None), name_col != ""
        )
    elif field == "label":
        name_col = Movie.label_name
        stmt = select(name_col, func.count(func.distinct(Movie.id)).label("cnt")).where(
            Movie.is_visible.is_(True), name_col.is_not(None), name_col != ""
        )
    else:
        # Literal で塞いではいるが念のため
        return []

    if pattern is not None:
        stmt = stmt.where(name_col.ilike(pattern))

    # 同件数の場合は名前順で安定ソート
    stmt = (
        stmt.group_by(name_col)
        .order_by(func.count(func.distinct(Movie.id)).desc(), name_col.asc())
        .limit(limit)
    )

    result = await db.execute(stmt)
    return [row[0] for row in result.all()]
