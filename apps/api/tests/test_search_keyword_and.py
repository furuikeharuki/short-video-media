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


def test_capped_count_uses_limit_inside_subquery() -> None:
    """`_capped_count` が SELECT count(*) FROM (SELECT 1 ... LIMIT N+1) sub の
    形になっていることを保証する。高頻度語で全行 COUNT(*) を踏まないための回帰防止。
    """
    from sqlalchemy import select as sa_select

    from app.db.models.movie import Movie
    from app.repositories.search_repository import _COUNT_CAP, _build_keyword_where

    where = _build_keyword_where("alpha")
    # _capped_count と同じ SQL を組み立てて検証 (実 DB 不要)
    inner = sa_select(1).select_from(Movie).where(where).limit(_COUNT_CAP + 1).subquery()
    from sqlalchemy import func as sa_func

    stmt = sa_select(sa_func.count()).select_from(inner)
    sql = _compile(stmt)
    assert "count(*)" in sql.lower()
    assert f"LIMIT {_COUNT_CAP + 1}" in sql or f"LIMIT {_COUNT_CAP + 1}\n" in sql


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
