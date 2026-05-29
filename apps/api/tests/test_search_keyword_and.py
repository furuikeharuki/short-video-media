"""フリーワード q のスペース AND 分割をリポジトリ層でテストする。

DB に接続せず、`_split_keyword_tokens` のトークン分割と `_build_keyword_where`
が生成する SQL の形 (AND で複数の OR グループが結合される) を確認する。
"""
from __future__ import annotations

import pytest
from sqlalchemy.dialects import postgresql

from sqlalchemy import and_

from app.repositories.search_repository import (
    _build_advanced_conditions,
    _build_keyword_where,
    _split_keyword_tokens,
)


# ---------------- トークン分割 ----------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("alpha", ["alpha"]),
        ("alpha beta", ["alpha", "beta"]),
        # 全角スペースもトークン区切りにする
        ("alpha　beta", ["alpha", "beta"]),
        # 全角・半角混在 + 連続スペースを正規化
        ("alpha   beta　　gamma", ["alpha", "beta", "gamma"]),
        ("  leading and trailing  ", ["leading", "and", "trailing"]),
        # タブ・改行も区切り
        ("alpha\tbeta\ngamma", ["alpha", "beta", "gamma"]),
        # 全部空白 → 空リスト
        (" 　 \t ", []),
        ("", []),
    ],
)
def test_split_keyword_tokens(raw: str, expected: list[str]) -> None:
    assert _split_keyword_tokens(raw) == expected


# ---------------- SQL 形状 ----------------


def _compile(expr) -> str:
    """SQLAlchemy 式を PostgreSQL 方言でリテラル埋め込みして文字列化する。"""
    return str(
        expr.compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    )


def test_single_keyword_emits_single_or_group() -> None:
    """空白なしの単一キーワードは従来通り 1 つの OR グループになる。

    EXISTS サブクエリ内には自身の WHERE で AND が含まれるが、
    それはトークン間結合ではなくサブクエリ内部条件。
    「同じパターン (alpha) が複数のトークンとして繰り返されていない」ことで
    トップレベル AND が無いことを担保する。
    """
    sql = _compile(_build_keyword_where("alpha"))
    # 単一キーワードでは alpha のパターンが現れ、別キーワードは混ざらない。
    # (psycopg のパラメータバインドで '%' は SQL に '%%' として出るため、
    #  ILIKE '%%alpha%%' の形を許容する。)
    assert "alpha" in sql
    assert "beta" not in sql
    # 単一トークンであれば、同じ %alpha% パターンが
    # OR グループ 1 セット分しか出てこない。スペース分割で AND されたら
    # 同じ %alpha% パターンが 2 セット出現する。
    # 1 セット = title / description / director / maker / label / actress /
    # genre / series の合計 8 か所。
    assert sql.count("%%alpha%%") == 8


def test_space_separated_keyword_uses_and_of_or_groups() -> None:
    """`alpha beta` のように半角スペースで区切ると AND 検索になる。"""
    sql = _compile(_build_keyword_where("alpha beta"))
    # 各トークンのパターンが SQL 内に登場する
    assert "%alpha%" in sql
    assert "%beta%" in sql
    # alpha も beta も独立して OR ブロックを持つ → AND で連結される
    # 具体的な SQL 文字列に依存しすぎないために、それぞれが含まれることだけ確認しつつ、
    # AND が SQL に現れることを確認する。
    assert " AND " in sql


def test_full_width_space_also_splits() -> None:
    """全角スペース U+3000 でも AND 分割される。"""
    sql = _compile(_build_keyword_where("alpha　beta"))
    assert "%alpha%" in sql
    assert "%beta%" in sql
    assert " AND " in sql
    # 全角スペースをパターンに含むトークンが残っていないこと (= ちゃんと分割された)
    assert "alpha　beta" not in sql


def test_multiple_consecutive_spaces_normalized() -> None:
    """連続スペースは 1 区切りに正規化されて余計な空トークンが入らない。"""
    sql = _compile(_build_keyword_where("alpha   beta"))
    assert "%alpha%" in sql
    assert "%beta%" in sql
    # 空文字トークン化されていない (空 LIKE '%%' は元の単純検索を破壊しない)
    # 連続スペース部分が token として出ていれば SQL に "%   %" 等が出るので、それが無いことを確認
    assert "%   %" not in sql


def test_three_tokens_produce_three_and_groups() -> None:
    """3 語のスペース区切り → 3 グループの AND 連結。"""
    sql = _compile(_build_keyword_where("alpha beta gamma"))
    assert "%alpha%" in sql
    assert "%beta%" in sql
    assert "%gamma%" in sql
    # AND が 2 個以上 (3 グループを連結するための AND が最低 2 つ)
    assert sql.count(" AND ") >= 2


# ---------------- q × その他フィルター ----------------


def test_advanced_conditions_q_and_genres_and_actresses_are_anded() -> None:
    """詳細検索: q (1 語) + genres + actresses が AND で結合されることを確認する。

    保存済み詳細条件 (フリーワード含む) がタグ遷移や検索アイコン経路でも AND で
    効くことの保証。条件は `where(*conditions)` で AND されるので、
    `_build_advanced_conditions` の返す list を `and_(*conds)` で連結して SQL を見る。
    """
    conds = _build_advanced_conditions(
        q="alpha",
        genres=["G1"],
        actresses=["A1"],
        series_list=[],
        directors=[],
        makers=[],
        labels=[],
        date_from=None,
        date_to=None,
        ng_words=[],
    )
    sql = _compile(and_(*conds))
    # q トークン
    assert "%alpha%" in sql
    # ジャンル / 女優のサブクエリ (名前で IN される)
    assert "G1" in sql
    assert "A1" in sql
    # 少なくとも 3 ブロックを連結する 2 つ以上の AND がある
    assert sql.count(" AND ") >= 2


def test_advanced_conditions_multi_token_q_with_genres_all_anded() -> None:
    """`q="alpha beta"` (AND 2 トークン) + genres が全部 AND される。

    q 内部の AND と q ↔ 詳細フィルター間の AND が両立すること。
    """
    conds = _build_advanced_conditions(
        q="alpha beta",
        genres=["G1"],
        actresses=[],
        series_list=[],
        directors=[],
        makers=[],
        labels=[],
        date_from=None,
        date_to=None,
        ng_words=[],
    )
    sql = _compile(and_(*conds))
    assert "%alpha%" in sql
    assert "%beta%" in sql
    assert "G1" in sql
    # q 内 AND (alpha と beta) + q ↔ genres 間 AND で AND が複数登場する
    assert sql.count(" AND ") >= 2


# ---------------- パフォーマンス回帰防止 ----------------


def test_search_movies_count_uses_count_star_not_count_distinct() -> None:
    """`search_movies` の total カウントが COUNT(DISTINCT id) ではなく
    COUNT(*) になっていることを保証する。

    WHERE が EXISTS / 直接カラム比較しかないので Movie 行は膨張せず、
    DISTINCT を取ると不要にソート / ハッシュが入って遅くなる。
    リファクタで戻ってしまった場合に気付ける回帰テスト。
    """
    from sqlalchemy import func, select

    from app.db.models.movie import Movie
    from app.repositories.search_repository import _build_keyword_where

    where = _build_keyword_where("alpha")
    count_stmt = select(func.count()).select_from(Movie).where(where)
    sql = _compile(count_stmt)
    assert "count(*)" in sql.lower()
    assert "distinct" not in sql.lower()


def test_search_movies_orders_by_indexed_primary_date_desc() -> None:
    """`search_movies` の items 取得が ORDER BY primary_date DESC NULLS LAST, id で
    出ていることを保証する。

    Movie.title には B-tree index が無いため、`ORDER BY title` だと数千件マッチする
    キーワードで全マッチ行を読み込んでメモリソートしてから LIMIT 20 する形になり、
    API レイテンシが 2 秒前後になる回帰を防ぐ。
    primary_date には単独 / 複合 index があり、planner は top-K 早期打ち切りプランを
    選べる。
    """
    from sqlalchemy import select as sa_select

    from app.db.models.movie import Movie
    from app.repositories.search_repository import _build_keyword_where

    where = _build_keyword_where("alpha")
    stmt = (
        sa_select(Movie)
        .where(where)
        .order_by(Movie.primary_date.desc().nullslast(), Movie.id)
        .limit(20)
    )
    sql = _compile(stmt)
    # primary_date DESC NULLS LAST が ORDER BY に乗っている
    assert "ORDER BY movies.primary_date DESC NULLS LAST" in sql
    # title による ORDER BY が混入していない (索引が無いので使ってはいけない)
    assert "ORDER BY movies.title" not in sql


def test_keyword_where_uses_or_with_correlated_exists() -> None:
    """単一トークンの WHERE は title / description などへの ILIKE と、女優 / ジャンル /
    シリーズに対する相関 EXISTS の OR で構成されている。

    PR #293 で UNION ALL ベースの IN サブクエリに切り替えたが、フィードの
    `get_advanced_movie_ids` (LIMIT 無しの全 ID 列挙) と組み合わさると plan が
    悪化して本番が極端に遅くなる回帰を出したため、PR #291 の EXISTS 形に戻している。

    OR + EXISTS 形に戻っていることを SQL シェイプで担保する (回帰防止)。
    """
    sql = _compile(_build_keyword_where("alpha"))
    # UNION ALL は (このリポジトリ層では) 使われていない
    assert "UNION ALL" not in sql.upper()
    # 各 EXISTS サブクエリが含まれている
    assert "EXISTS (SELECT" in sql or "EXISTS(SELECT" in sql or "(EXISTS" in sql
    # ILIKE による直接カラム比較も並んでいる
    assert "movies.title ILIKE" in sql
    assert "movies.description ILIKE" in sql


def test_repository_no_longer_uses_capped_count_helper() -> None:
    """has_more 判定は items の limit+1 から導出するので、別 COUNT クエリは
    使わない。`_capped_count` / `_COUNT_CAP` が再復活して 2 本目のスキャンが
    走るような回帰を防ぐ。
    """
    import app.repositories.search_repository as repo

    assert not hasattr(repo, "_capped_count")
    assert not hasattr(repo, "_COUNT_CAP")


def test_advanced_conditions_uses_in_subquery_not_join_for_series() -> None:
    """series_list は Series JOIN ではなく `Movie.series_id IN (subquery)` で
    実装されていることを保証する (JOIN だと行数が膨らんで COUNT(*) も狂う)。"""
    from sqlalchemy import and_

    from app.repositories.search_repository import _build_advanced_conditions

    conds = _build_advanced_conditions(
        q=None,
        genres=[],
        actresses=[],
        series_list=["MySeries"],
        directors=[],
        makers=[],
        labels=[],
        date_from=None,
        date_to=None,
        ng_words=[],
    )
    sql = _compile(and_(*conds))
    # IN (SELECT ... FROM series ...) 形式になっている
    assert "series_id IN" in sql or "movies.series_id IN" in sql
    assert "MySeries" in sql


# ---------------- 冗長 q トークンの除去 ----------------


def test_q_equals_genre_value_is_dropped_from_conditions() -> None:
    """`q="巨乳" genres=["巨乳"]` のように q が genres 値と完全一致する場合、
    キーワード OR 全体が genre フィルタにより常に true になるため落とす。

    実本番で `q=巨乳&genres=巨乳&ng_words=...` のリクエストが 10 秒前後かかる
    主因はこの広域 OR (5 ILIKE + 3 相関 EXISTS) が planner を惑わせて
    全件スキャン気味のプランを選ぶこと。
    """
    from sqlalchemy import and_

    from app.repositories.search_repository import _build_advanced_conditions

    conds = _build_advanced_conditions(
        q="巨乳",
        genres=["巨乳"],
        actresses=[],
        series_list=[],
        directors=[],
        makers=[],
        labels=[],
        date_from=None,
        date_to=None,
        ng_words=[],
    )
    sql = _compile(and_(*conds))
    # genres フィルタは残る
    assert "movie_genres" in sql
    assert "巨乳" in sql
    # キーワード OR の中核 (title/description ILIKE) が SQL に現れていない
    # = q ブランチごと丸ごと除去された
    assert "movies.title ILIKE" not in sql
    assert "movies.description ILIKE" not in sql


def test_q_equals_actress_value_is_dropped() -> None:
    """`q=女優A actresses=["女優A"]` で q は冗長 → 落ちる。"""
    from sqlalchemy import and_

    from app.repositories.search_repository import _build_advanced_conditions

    conds = _build_advanced_conditions(
        q="女優A",
        genres=[],
        actresses=["女優A"],
        series_list=[],
        directors=[],
        makers=[],
        labels=[],
        date_from=None,
        date_to=None,
        ng_words=[],
    )
    sql = _compile(and_(*conds))
    assert "movie_actresses" in sql
    assert "女優A" in sql
    assert "movies.title ILIKE" not in sql


def test_q_equals_label_value_is_dropped() -> None:
    """labels も同様。"""
    from sqlalchemy import and_

    from app.repositories.search_repository import _build_advanced_conditions

    conds = _build_advanced_conditions(
        q="MyLabel",
        genres=[],
        actresses=[],
        series_list=[],
        directors=[],
        makers=[],
        labels=["MyLabel"],
        date_from=None,
        date_to=None,
        ng_words=[],
    )
    sql = _compile(and_(*conds))
    # labels フィルタは残る
    assert "MyLabel" in sql
    assert "label_name IN" in sql
    # q のキーワード OR は除去されている
    assert "movies.title ILIKE" not in sql


def test_q_partial_match_to_genre_value_is_kept() -> None:
    """`q=巨 genres=["巨乳"]` のように q がフィルタ値の部分文字列でしかない場合、
    キーワード OR は不冗長 → 残す。

    "巨" は genre 名 "巨乳" の部分文字列なので genre フィルタを満たす作品では
    genre_exists 枝が true になるが、それは genres=巨乳 を持つ作品では常に
    そうとは限らない (genre "巨乳" を持つ作品の中で title が "巨" を含むものは
    title 枝でもマッチするが、含まないものは genre 枝のみでマッチ)。
    安全側として「q トークンと完全一致した時のみ落とす」ルールにしているため、
    部分一致では q は残る。
    """
    from sqlalchemy import and_

    from app.repositories.search_repository import _build_advanced_conditions

    conds = _build_advanced_conditions(
        q="巨",
        genres=["巨乳"],
        actresses=[],
        series_list=[],
        directors=[],
        makers=[],
        labels=[],
        date_from=None,
        date_to=None,
        ng_words=[],
    )
    sql = _compile(and_(*conds))
    # genre フィルタ + キーワード OR の両方が残る
    assert "movie_genres" in sql
    assert "movies.title ILIKE" in sql


def test_q_mixed_redundant_and_unique_tokens_keeps_unique_only() -> None:
    """`q="巨乳 アイドル"` + `genres=["巨乳"]` で「巨乳」は冗長、「アイドル」は不冗長
    → 「アイドル」だけ残る AND になる。"""
    from sqlalchemy import and_

    from app.repositories.search_repository import _build_advanced_conditions

    conds = _build_advanced_conditions(
        q="巨乳 アイドル",
        genres=["巨乳"],
        actresses=[],
        series_list=[],
        directors=[],
        makers=[],
        labels=[],
        date_from=None,
        date_to=None,
        ng_words=[],
    )
    sql = _compile(and_(*conds))
    # 「アイドル」のキーワード OR は残る
    assert "%アイドル%" in sql
    # 「巨乳」のキーワード OR は消える (巨乳 はキーワード OR ではなく genre フィルタ側にだけ現れる)
    assert "%巨乳%" not in sql
    # genres フィルタの SQL 内では 巨乳 は IN リテラルとして存在する
    assert "'巨乳'" in sql


def test_q_redundant_case_insensitive_match() -> None:
    """case-insensitive で比較する: q='ALPHA' genres=['alpha'] でも冗長判定。"""
    from sqlalchemy import and_

    from app.repositories.search_repository import _build_advanced_conditions

    conds = _build_advanced_conditions(
        q="ALPHA",
        genres=["alpha"],
        actresses=[],
        series_list=[],
        directors=[],
        makers=[],
        labels=[],
        date_from=None,
        date_to=None,
        ng_words=[],
    )
    sql = _compile(and_(*conds))
    # q のキーワード OR は除去されている (case-insensitive 完全一致なので)
    assert "movies.title ILIKE" not in sql


def test_q_no_overlap_with_filters_keeps_q() -> None:
    """`q="別ワード"` + `genres=["巨乳"]` のように q がどのフィルタ値とも一致しない時は
    キーワード OR を残す。"""
    from sqlalchemy import and_

    from app.repositories.search_repository import _build_advanced_conditions

    conds = _build_advanced_conditions(
        q="別ワード",
        genres=["巨乳"],
        actresses=[],
        series_list=[],
        directors=[],
        makers=[],
        labels=[],
        date_from=None,
        date_to=None,
        ng_words=[],
    )
    sql = _compile(and_(*conds))
    assert "%別ワード%" in sql
    assert "movies.title ILIKE" in sql


# ---------------- NG ワードは NOT EXISTS で評価される ----------------


def test_ng_word_uses_not_exists_for_actress_genre_series() -> None:
    """NG ワード除外の女優 / ジャンル / シリーズ判定が
    `NOT IN (subquery)` ではなく `NOT (EXISTS ...)` で書かれていることを保証する。

    `NOT IN` は planner が hash anti-join + materialize に倒れがちで
    subquery が大きいときに遅い。`NOT EXISTS` は相関 anti-semi-join + 逆方向
    index で個別行ずつ判定でき、`ng_words=熟女` のように subquery が数千件返す
    ケースで安定して速い。回帰防止。
    """
    from sqlalchemy import and_

    from app.repositories.search_repository import _build_advanced_conditions

    conds = _build_advanced_conditions(
        q=None,
        genres=[],
        actresses=[],
        series_list=[],
        directors=[],
        makers=[],
        labels=[],
        date_from=None,
        date_to=None,
        ng_words=["レズ"],
    )
    sql = _compile(and_(*conds))
    # NOT EXISTS が現れている (相関 sub)
    upper = sql.upper()
    assert "NOT (EXISTS" in upper or "NOT EXISTS" in upper
    # ng の subquery が `Movie.id` と相関している (movie_id = movies.id の形)
    assert "movie_genres.movie_id = movies.id" in sql
    assert "movie_actresses.movie_id = movies.id" in sql
    # series は series_id = movies.series_id で相関
    assert "series.id = movies.series_id" in sql


def test_ng_word_no_longer_uses_not_in_for_join_tables() -> None:
    """`movie_id IN (SELECT movie_id FROM movie_genres ...)` の NOT IN 形が
    残っていないこと。NOT IN は anti-join planner を惑わせる回帰の元。"""
    from sqlalchemy import and_

    from app.repositories.search_repository import _build_advanced_conditions

    conds = _build_advanced_conditions(
        q=None,
        genres=[],
        actresses=[],
        series_list=[],
        directors=[],
        makers=[],
        labels=[],
        date_from=None,
        date_to=None,
        ng_words=["熟女"],
    )
    sql = _compile(and_(*conds))
    # 「movies.id NOT IN (SELECT ... movie_genres ...)」のような形が存在しないこと
    assert "movies.id NOT IN" not in sql


def test_ng_word_with_q_and_genres_combined() -> None:
    """本番リクエストと同形 (q + genres + ng_words 4 件) で
    全条件が組み上がることをスモーク。"""
    from sqlalchemy import and_

    from app.repositories.search_repository import _build_advanced_conditions

    conds = _build_advanced_conditions(
        q="巨乳",
        genres=["巨乳"],
        actresses=[],
        series_list=[],
        directors=[],
        makers=[],
        labels=[],
        date_from=None,
        date_to=None,
        ng_words=["レズ", "熟女", "スカトロ", "近親相姦"],
    )
    sql = _compile(and_(*conds))
    # q は genres に冗長で落ちる
    assert "movies.title ILIKE" not in sql
    # genres フィルタは残る
    assert "movie_genres" in sql
    # NG ワード 4 件分の NOT EXISTS が乗っている
    upper = sql.upper()
    assert upper.count("NOT (EXISTS") + upper.count("NOT EXISTS") >= 4 * 3  # 4 ワード × 3 サブ (actress/genre/series)


def test_q_redundant_with_directors_value() -> None:
    """directors の値と q が一致する場合も冗長 → 落ちる。"""
    from sqlalchemy import and_

    from app.repositories.search_repository import _build_advanced_conditions

    conds = _build_advanced_conditions(
        q="監督X",
        genres=[],
        actresses=[],
        series_list=[],
        directors=["監督X"],
        makers=[],
        labels=[],
        date_from=None,
        date_to=None,
        ng_words=[],
    )
    sql = _compile(and_(*conds))
    # directors フィルタ (director_name IN) は残る
    assert "director_name IN" in sql
    assert "監督X" in sql
    # q のキーワード OR は除去
    assert "movies.title ILIKE" not in sql


def test_q_redundant_with_series_value() -> None:
    """series_list の値と q が一致する場合も冗長 → 落ちる。"""
    from sqlalchemy import and_

    from app.repositories.search_repository import _build_advanced_conditions

    conds = _build_advanced_conditions(
        q="MySeries",
        genres=[],
        actresses=[],
        series_list=["MySeries"],
        directors=[],
        makers=[],
        labels=[],
        date_from=None,
        date_to=None,
        ng_words=[],
    )
    sql = _compile(and_(*conds))
    assert "series_id IN" in sql or "movies.series_id IN" in sql
    assert "MySeries" in sql
    # q のキーワード OR は除去
    assert "movies.title ILIKE" not in sql
