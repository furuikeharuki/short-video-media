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

    注: PR #293 で UNION ALL ベースの候補 movie_id 集合 + Movie.id IN (...)
    に置き換えていたが、フィード経路 (`get_advanced_movie_ids` → LIMIT 無しで
    全 ID を取得) と組み合わさるとプランナが巨大な IN セットを材料化して
    本番が極端に遅くなる回帰を出したため、PR #291 の EXISTS 形に戻している。
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

    `total` はクライアント (`/api/v1/search` の next_cursor 判定) にしか使われない。
    そのため別クエリで COUNT を取る代わりに「limit+1 件取りに行って、+1 件まで
    届いたら has_more=true」というよく知られた省力化を使う。これで広域マッチする
    キーワードでも 2 本目のスキャンが不要になり、レイテンシをおおむね半減できる。
    `total` の体裁は `offset + len(items)` (= 末尾なら確定数、続きがあれば
    "今までに見えた件数 + 1" の正の値) で返す。next_cursor は items 件数で判定。
    """
    where = _build_keyword_where(query)

    # ORDER BY を Movie.title (索引無し) から Movie.primary_date DESC (索引あり) に変更。
    # primary_date は単独 index + 複合 index (ix_movies_visible_primary_date) を持つので、
    # planner は「primary_date index を新しい順に走査し、WHERE にマッチした行を 20 件
    # 集まるまで読む」プランを選べる (top-K 早期打ち切り)。
    stmt = (
        select(Movie)
        .where(where)
        .order_by(Movie.primary_date.desc().nullslast(), Movie.id)
    )
    if offset:
        stmt = stmt.offset(offset)
    # limit=None の場合は全件取得 (旧来の挙動互換)。
    if limit is not None:
        stmt = stmt.limit(limit + 1)

    result = await db.execute(stmt)
    rows = list(result.scalars().unique().all())
    has_more = limit is not None and len(rows) > limit
    if has_more:
        rows = rows[:limit]
    total = offset + len(rows) + (1 if has_more else 0)
    return rows, int(total)


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

    # `total` は next_cursor の has_more 判定にしか使わないため、別 COUNT クエリを
    # 投げずに limit+1 件取って has_more を導出する (search_movies と同じ手)。
    stmt = select(Movie).where(*conditions).order_by(
        Movie.delivery_date.desc().nullslast(), Movie.id
    )
    if offset:
        stmt = stmt.offset(offset)
    if limit is not None:
        stmt = stmt.limit(limit + 1)

    result = await db.execute(stmt)
    rows = list(result.scalars().unique().all())
    has_more = limit is not None and len(rows) > limit
    if has_more:
        rows = rows[:limit]
    total = offset + len(rows) + (1 if has_more else 0)
    return rows, int(total)


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
    #
    # 以前は `Movie.id IN (SELECT movie_id ... HAVING COUNT(DISTINCT name)=N)` を
    # 使っていたが、本番 EXPLAIN でこれが主因のレイテンシを生んでいた:
    # planner が positive 候補 movie_id を全件 (例: 21,972 件) HashAggregate で
    # 材料化 → movies_pkey へ Nested Loop で 21,972 回ランダムアクセスし、
    # その各行に対して ng_words の相関 NOT EXISTS を評価してから Sort+Limit する。
    # 22 件しか要らないのに 21,972 件分の pkey lookup + ng フィルタを舐めていた。
    #
    # ジャンル名ごとに 1 つの相関 EXISTS に分解する (「N 個すべて持つ」=「各 N に
    # ついて EXISTS」)。こうすると planner は movies を primary_date DESC index 順に
    # 走査し、各 movie に対し逆方向 index (ix_movie_genres_genre_id) で安価に
    # EXISTS 判定でき、LIMIT 22 に達したら早期打ち切りできる (top-K)。
    # ng_words の NOT EXISTS も「実際に上位に来た少数の movie」にしか評価されない。
    #
    # フィード経路 (`get_advanced_movie_ids`, LIMIT 無し) でも、IN の巨大候補集合を
    # 材料化しない分だけ安全側 (PR #293 の IN 材料化回帰を再発させない)。
    if genres:
        for name in genres:
            genre_exists = (
                select(1)
                .select_from(MovieGenre)
                .join(Genre, Genre.id == MovieGenre.genre_id)
                .where(MovieGenre.movie_id == Movie.id, Genre.name == name)
                .exists()
            )
            conditions.append(genre_exists)

    # 女優 AND: 同じ手で 1 女優 = 1 相関 EXISTS に分解する。
    if actresses:
        for name in actresses:
            actress_exists = (
                select(1)
                .select_from(MovieActress)
                .join(Actress, Actress.id == MovieActress.actress_id)
                .where(MovieActress.movie_id == Movie.id, Actress.name == name)
                .exists()
            )
            conditions.append(actress_exists)

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

    # items: ソート種別に応じてサブクエリを組み立てる。
    # `total` は client 側で next_cursor 判定 (has_more) にしか使わないので
    # 別 COUNT クエリを撤去し、items を limit+1 件取って has_more を導出する。
    # 高頻度キーワード × ng_words など、WHERE が広くマッチする条件で
    # COUNT(*) 用に 1001 行スキャンしていた分のレイテンシを丸ごと削減できる
    # (ORDER BY top-K の items クエリと統合)。
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
        stmt = stmt.limit(limit + 1)

    result = await db.execute(stmt)
    rows = list(result.scalars().unique().all())
    has_more = limit is not None and len(rows) > limit
    if has_more:
        rows = rows[:limit]
    total = offset + len(rows) + (1 if has_more else 0)
    return rows, int(total)


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
