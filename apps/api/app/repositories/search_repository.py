from __future__ import annotations

import re
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


# 半角スペース / 全角スペース (U+3000) / タブ / 改行など、Unicode 的な空白すべてで分割する。
# 連続空白は \s+ で 1 つにまとまる。
_KEYWORD_SPLIT_RE = re.compile(r"[\s　]+")


def _split_keyword_tokens(query: str) -> list[str]:
    """フリーワード `q` を AND 検索用のトークン列に分割する。

    - 半角 / 全角スペース / タブ / 改行を区切りとして扱う
    - 連続空白は 1 区切りに正規化
    - 前後の空白は除去
    - 空文字は除外
    - 入力にスペースが全く無ければ要素 1 個のリストになる (= 既存と同じ単一キーワード検索)
    """
    if not query:
        return []
    parts = _KEYWORD_SPLIT_RE.split(query.strip())
    return [p for p in parts if p]


def _build_token_where(token: str):
    """単一トークンに対する OR 条件 (title / description / director / maker / label /
    女優名 / ジャンル名 / シリーズ名 の部分一致いずれか) を返す。

    女優 / ジャンル / シリーズは IN (...) の代わりに EXISTS を使う。
    pg_trgm GIN index と組み合わせた時に planner が選択しやすく、
    行数が多くなっても IN マテリアライズを避けられる。
    """
    pat = f"%{token}%"

    actress_exists = (
        select(1)
        .select_from(MovieActress)
        .join(Actress, Actress.id == MovieActress.actress_id)
        .where(MovieActress.movie_id == Movie.id, Actress.name.ilike(pat))
        .exists()
    )
    genre_exists = (
        select(1)
        .select_from(MovieGenre)
        .join(Genre, Genre.id == MovieGenre.genre_id)
        .where(MovieGenre.movie_id == Movie.id, Genre.name.ilike(pat))
        .exists()
    )
    series_exists = (
        select(1)
        .select_from(Series)
        .where(Series.id == Movie.series_id, Series.name.ilike(pat))
        .exists()
    )

    return or_(
        Movie.title.ilike(pat),
        Movie.description.ilike(pat),
        Movie.director_name.ilike(pat),
        Movie.maker_name.ilike(pat),
        Movie.label_name.ilike(pat),
        actress_exists,
        genre_exists,
        series_exists,
    )


def _build_keyword_where(query: str):
    """`search_movies` で使う WHERE 条件を返す。

    フリーワードに空白 (半角 / 全角) が含まれる場合は AND 検索とする。
    例: `q="alpha beta"` は (alpha のどこかにマッチ) AND (beta のどこかにマッチ) になる。
    各トークンは内部で「タイトル / 説明 / 女優名 / ジャンル名 / 監督 / メーカー /
    レーベル / シリーズ名」の OR で評価され、トークン同士は AND で結合される。

    total カウント用と items 取得用で重複するロジックをここに集約する。
    """
    tokens = _split_keyword_tokens(query)
    if not tokens:
        # 空白だけ / 空文字 → 既存挙動 (1 ワードとしての ilike) と同じく ""%%"" で全件マッチ。
        # 呼び出し側は通常空文字を渡さないが、安全側で動作を維持する。
        return _build_token_where(query)
    if len(tokens) == 1:
        return _build_token_where(tokens[0])
    return and_(*(_build_token_where(t) for t in tokens))


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

    # WHERE は EXISTS / 直接カラム比較のみで Movie をマルチプライしないので
    # DISTINCT を取らずに COUNT(*) で十分 (DISTINCT は大規模データでソート/ハッシュが入って遅い)。
    count_stmt = select(func.count()).select_from(Movie).where(where)
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
    if director:
        conditions.append(Movie.director_name == director)
    if maker:
        conditions.append(Movie.maker_name == maker)
    if label:
        conditions.append(Movie.label_name == label)
    if series:
        # Series JOIN を避けて FK 直接照合のサブクエリにする (Series.name に
        # 一致する series_id 群を引いて IN するだけ)。これで Movie 側に
        # 行数膨張がなく DISTINCT も不要。
        conditions.append(
            Movie.series_id.in_(select(Series.id).where(Series.name == series))
        )

    if not conditions:
        return [], 0

    # Movie に対する直値比較 / IN サブクエリしか無いので COUNT(*) で OK。
    count_stmt = select(func.count()).select_from(Movie).where(*conditions)
    total = (await db.execute(count_stmt)).scalar_one()

    # items 取得 (delivery_date 降順、同日内は id で安定ソート)
    stmt = select(Movie).where(*conditions).order_by(
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

    # total は items 取得とは別クエリで先に取る (next_cursor 判定に使う)。
    # 全 WHERE 条件は Movie へのスカラー比較か Movie.id.in_(subquery) のみで
    # 行数を膨張させないので COUNT(*) で OK (DISTINCT 不要)。
    count_stmt = select(func.count()).select_from(Movie).where(*conditions)
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


async def get_advanced_movie_ids(
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
    sort: SortKey | None = None,
) -> list[str]:
    """詳細検索条件にマッチする movie_id を全件列挙して返す。

    フィード (ショート動画) の順番決めのソースとして使う。

    sort が None (未指定) のときは呼び出し側で shuffle される前提で id ASC だけを使う。
    sort が指定されたときは advanced_search_movies と同じ ORDER BY で並べた ID を返すと、
    呼び出し側で shuffle せずにその順番でフィードを作れる。
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

    if sort is None:
        stmt = (
            select(Movie.id)
            .where(*conditions)
            .order_by(Movie.id.asc())
        )
        result = await db.execute(stmt)
        return [str(r[0]) for r in result.all()]

    # sort 指定あり: advanced_search_movies と同じ ORDER BY ロジックを id 取得にも適用
    stmt = select(Movie.id).where(*conditions)

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
        stmt = stmt.order_by(
            Movie.primary_date.desc().nullslast(), Movie.id.asc()
        )

    result = await db.execute(stmt)
    return [str(r[0]) for r in result.all()]


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
        # director_name は Movie の直値カラム。1 行 = 1 作品なので COUNT(*) で OK。
        name_col = Movie.director_name
        stmt = select(name_col, func.count().label("cnt")).where(
            Movie.is_visible.is_(True), name_col.is_not(None), name_col != ""
        )
    elif field == "maker":
        name_col = Movie.maker_name
        stmt = select(name_col, func.count().label("cnt")).where(
            Movie.is_visible.is_(True), name_col.is_not(None), name_col != ""
        )
    elif field == "label":
        name_col = Movie.label_name
        stmt = select(name_col, func.count().label("cnt")).where(
            Movie.is_visible.is_(True), name_col.is_not(None), name_col != ""
        )
    else:
        # Literal で塞いではいるが念のため
        return []

    if pattern is not None:
        stmt = stmt.where(name_col.ilike(pattern))

    # 同件数の場合は名前順で安定ソート。
    # cnt カラム (各 elif で計算したカウント式) で desc 順 → 名前 asc。
    # SQLAlchemy の column() でラベル参照する代わりに、ORDER BY 2 (位置参照) を使うと
    # ポータブルかつ実装に依存しないが、SQLAlchemy は ORDER BY 1/2 を直接サポート
    # しないので、ここはコンパイル済みの集約式を再構築する。
    cnt_expr = (
        func.count(func.distinct(Movie.id))
        if field in ("actress", "genre", "series")
        else func.count()
    )
    stmt = (
        stmt.group_by(name_col)
        .order_by(cnt_expr.desc(), name_col.asc())
        .limit(limit)
    )

    result = await db.execute(stmt)
    return [row[0] for row in result.all()]
