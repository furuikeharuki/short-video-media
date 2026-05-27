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
    """空白なしの単一キーワードは従来通り 1 つの OR グループになる。"""
    sql = _compile(_build_keyword_where("alpha"))
    # 単一キーワードでは alpha のパターンが現れ、別キーワードは混ざらない。
    # (psycopg のパラメータバインドで '%' は SQL に '%%' として出るため、
    #  ILIKE '%%alpha%%' の形を許容する。)
    assert "alpha" in sql
    assert "beta" not in sql
    # 単一トークンなら AND で別グループに連結されていない。
    assert " AND " not in sql


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
