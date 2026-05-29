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


# `total` を計算する際の上限。WHERE が広くマッチする (例: `q=巨乳` のような
# 高頻度語) と、純粋な COUNT(*) でも全マッチ行をスキャンしないと総数が出ない。
# UI では正確な総数は使っておらず (`next_cursor` の has_more 判定に使うだけ)、
# ページングは offset+limit が cap を超えない範囲で動けば十分。
# よって SELECT count(*) FROM (SELECT 1 FROM ... WHERE ... LIMIT cap+1) で
# cap+1 件目に達した時点で打ち切る。
#
# cap = 1000 なら limit=20 で 50 ページまでページング可能。
# 「もっと絞ってください」と UX 上促す前提でも十分な深さ。
_COUNT_CAP = 1000


async def _capped_count(
    db: AsyncSession,
    where_clauses,
    *,
    cap: int = _COUNT_CAP,
) -> int:
    """`SELECT count(*) FROM (SELECT 1 FROM movies WHERE ... LIMIT cap+1)` で
    打ち切り付きカウントを返す。

    フリーワード検索のように WHERE が広くマッチする場合に、
    巨大な行数を最後まで数え上げないようにするための補助関数。
    返り値が cap+1 の場合「ヒット件数は cap+1 件以上 (実数不明)」を意味するが、
    呼び出し側ではこの値を `total` としてそのまま使えば has_more 判定は
    `offset + limit < total` で正しく回る。
    """
    inner = select(1).select_from(Movie)
    # where_clauses はリスト / 単一式 / and_() などのいずれもあり得る。
    # SQLAlchemy 側は where() に複数引数を渡せば AND になるので、
    # 受け取り側で正規化しておく。
    if isinstance(where_clauses, (list, tuple)):
        if where_clauses:
            inner = inner.where(*where_clauses)
    else:
        inner = inner.where(where_clauses)
    inner = inner.limit(cap + 1).subquery()

    stmt = select(func.count()).select_from(inner)
    total = (await db.execute(stmt)).scalar_one()
    return int(total)


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

    注: PR #293 で UNION ALL ベースの候補 movie_id 集合 + Movie.id IN (...)
    に置き換えていたが、フィード経路 (`get_advanced_movie_ids` → LIMIT 無しで
    全 ID を取得) と組み合わさるとプランナが巨大な IN セットを材料化して
    本番が極端に遅くなる回帰を出したため、PR #291 の EXISTS 形に戻している。
    高頻度 2 文字キーワードの遅さは `_capped_count` (cap 1000) 側で吸収する。
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

    # `total` は frontend の has_more 判定 (next_cursor 計算) にしか使われていない。
    # `q=巨乳` のような高頻度語では純粋な COUNT(*) でも全マッチ行をスキャンして
    # 1〜2 秒かかるため、cap+1 件で打ち切る (cap 件以下なら正確、超えていれば cap+1 を返す)。
    total = await _capped_count(db, where)

    # ORDER BY を Movie.title (索引無し) から Movie.primary_date DESC (索引あり) に変更。
    # title には B-tree index が無いため、`q=巨乳` のような数千件マッチするキーワードでは
    # 全マッチ行を読み込んでメモリ上で sort してから LIMIT 20 する形になり、API 全体の
    # レイテンシが 2 秒前後になる主因だった。
    # primary_date は単独 index + 複合 index (ix_movies_visible_primary_date) を持つので、
    # planner は「primary_date index を新しい順に走査し、WHERE にマッチした行を 20 件
    # 集まるまで読む」プランを選べる (top-K 早期打ち切り)。
    # ソート順としても新しい作品が先頭に来る方が ショート動画 UI の体験として自然なため、
    # advanced search の sort=new と挙動が揃う形になる。
    stmt = (
        select(Movie)
        .where(where)
        .order_by(Movie.primary_date.desc().nullslast(), Movie.id)
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

    # 完全一致でもメーカー大手などは数千件ヒットするので、フリーワード検索同様
    # cap 付きカウントで早期打ち切りする。
    total = await _capped_count(db, conditions)

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

    女優 / ジャンル / シリーズの除外は、`NOT IN (大きな subquery)` ではなく
    `NOT EXISTS (相関 subquery)` で表現する。`NOT IN` は planner が hash anti-join
    + materialize に倒れがちで、`ng_words=熟女` のように subquery が数千件返す
    ケースで遅くなる。`NOT EXISTS` は `movies.id` と相関しているため anti-semi-join
    + (actress_id, movie_id) 逆方向 index で個別行ずつ判定できる。
    """
    pat = f"%{word}%"
    ng_actress_exists = (
        select(1)
        .select_from(MovieActress)
        .join(Actress, Actress.id == MovieActress.actress_id)
        .where(MovieActress.movie_id == Movie.id, Actress.name.ilike(pat))
        .exists()
    )
    ng_genre_exists = (
        select(1)
        .select_from(MovieGenre)
        .join(Genre, Genre.id == MovieGenre.genre_id)
        .where(MovieGenre.movie_id == Movie.id, Genre.name.ilike(pat))
        .exists()
    )
    ng_series_exists = (
        select(1)
        .select_from(Series)
        .where(Series.id == Movie.series_id, Series.name.ilike(pat))
        .exists()
    )

    return and_(
        ~func.coalesce(Movie.title, "").ilike(pat),
        ~func.coalesce(Movie.description, "").ilike(pat),
        ~func.coalesce(Movie.director_name, "").ilike(pat),
        ~func.coalesce(Movie.maker_name, "").ilike(pat),
        ~func.coalesce(Movie.label_name, "").ilike(pat),
        ~ng_actress_exists,
        ~ng_genre_exists,
        # series_id が NULL の作品は EXISTS 自体が false なので NOT EXISTS は true。
        # コードレベルで or_() を残す必要は無いが、可読性のため明示的に書く。
        ~ng_series_exists,
    )


def _q_token_is_redundant_with_filters(
    token: str,
    *,
    genres: list[str],
    actresses: list[str],
    series_list: list[str],
    directors: list[str],
    makers: list[str],
    labels: list[str],
) -> bool:
    """`q` の単一トークンが、同時指定された構造化フィルタ値と完全一致するか判定する。

    キーワード OR は title/description/director/maker/label/女優名/ジャンル名/
    シリーズ名 のいずれかに部分一致すること、を意味する。一方、構造化フィルタが
    (例: genres=["巨乳"]) 指定された作品は必ず genre 名 "巨乳" を持つので、
    キーワードの "genre 名に部分一致" 枝が常に true になる → OR 全体が true →
    キーワード条件が AND の中で常に満たされる = 冗長。

    "完全一致" を要求するのは、例えば `q=巨` と `genres=["巨乳"]` のように
    トークンが genres 値の一部だけの場合、キーワードは genre "巨乳" 以外の枝
    (title="巨人...")  にも有意にマッチし得るため、これは冗長ではないから。
    case-insensitive で照合する。

    対象フィールド:
      - genres → キーワード OR の `genre_exists (Genre.name ilike pat)` を満たす
      - actresses → `actress_exists (Actress.name ilike pat)` を満たす
      - series_list → `series_exists (Series.name ilike pat)` を満たす
      - directors → `Movie.director_name ilike pat` を満たす
      - makers → `Movie.maker_name ilike pat` を満たす
      - labels → `Movie.label_name ilike pat` を満たす
    """
    lt = token.casefold()
    candidates = (
        genres + actresses + series_list + directors + makers + labels
    )
    return any(v is not None and v.casefold() == lt for v in candidates)


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

    # キーワード (既存の全文部分一致と同じロジックを AND で合流)。
    #
    # 構造化フィルタ (genres/actresses/series_list/directors/makers/labels) と q が
    # 同時指定され、かつ q トークンの一部が「構造化フィルタの値そのもの」と完全一致
    # するときは、そのトークンに対応するキーワード OR 枝が必ず true となるため、
    # トークン条件 (OR グループ) は AND の中で常に true ⇒ 完全に冗長になる。
    # 例: `q=巨乳 genres=巨乳` では「巨乳」トークンは genre 名 "巨乳" を持つ作品で
    # 常にマッチ → 全 OR が常に true → 落としてよい。
    # この最適化により、高頻度 2 文字キーワード (`巨乳` 等) が引き起こす広域 OR を
    # planner から外せるため、構造化フィルタ単体での selectivity に倒し込める。
    #
    # 冗長でないトークンが残ればそれだけを AND し直す。全トークンが冗長になれば q ごと落とす。
    if q:
        tokens = _split_keyword_tokens(q)
        if not tokens:
            tokens = [q]
        non_redundant = [
            t
            for t in tokens
            if not _q_token_is_redundant_with_filters(
                t,
                genres=genres,
                actresses=actresses,
                series_list=series_list,
                directors=directors,
                makers=makers,
                labels=labels,
            )
        ]
        if non_redundant:
            if len(non_redundant) == 1:
                conditions.append(_build_token_where(non_redundant[0]))
            else:
                conditions.append(and_(*(_build_token_where(t) for t in non_redundant)))
        # else: 全トークンが構造化フィルタで冗長 → q 条件は付けない

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
    # 行数を膨張させないので COUNT(*) で OK。さらに `q=巨乳` のような
    # 広くマッチするキーワードでも cap+1 件で打ち切ることでレイテンシを抑える。
    total = await _capped_count(db, conditions)

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
