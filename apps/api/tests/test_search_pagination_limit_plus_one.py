"""`search_repository` の has_more 判定が items クエリの limit+1 から
導出されることを保証する。

PR #297 まで使われていた `_capped_count` (2 本目の COUNT クエリ) は撤去された。
items クエリ 1 本で「次ページがあるか」が分かるようにすることで、
高頻度語 (`q=巨乳` 等) + 構造化フィルタ + ng_words のようなレイテンシが
出やすいケースでスキャン量を半減させるためのリグレッション防止。

DB に実接続せず、`db.execute` を差し替えて以下を確認する:

- 返ってきた件数が limit+1 だったら呼び出し側で `limit` 件に切り詰め、
  `total = offset + limit + 1` を返す (= has_more 判定で True になる体裁)
- 返ってきた件数が limit 以下なら切り詰めず、`total = offset + len(rows)`
  を返す (= 末尾。next_cursor=None になる体裁)
- items クエリには LIMIT limit+1 が乗っている
- もう一本クエリ (旧 `_capped_count`) は発行されない (= execute 呼び出しが 1 回)
"""
from __future__ import annotations

from typing import Any

import pytest


class _FakeScalars:
    def __init__(self, items: list[Any]) -> None:
        self._items = items

    def unique(self) -> "_FakeScalars":
        return self

    def all(self) -> list[Any]:
        return list(self._items)


class _FakeResult:
    def __init__(self, items: list[Any]) -> None:
        self._items = items

    def scalars(self) -> _FakeScalars:
        return _FakeScalars(self._items)


class _RecordingDB:
    """`db.execute(stmt)` 呼び出しを記録し、登録した順に items を返すスタブ。"""

    def __init__(self, *, rows_per_call: list[list[Any]]) -> None:
        self._queue = list(rows_per_call)
        self.calls: list[Any] = []

    async def execute(self, stmt):  # noqa: ANN001
        self.calls.append(stmt)
        rows = self._queue.pop(0) if self._queue else []
        return _FakeResult(rows)


def _make_movie(i: int):
    """`unique()` で重複排除されないように object として戻すだけのダミー。"""

    class _M:
        id = f"00000000-0000-0000-0000-{i:012d}"

    return _M()


# ---------------- search_movies ----------------


@pytest.mark.asyncio
async def test_search_movies_marks_has_more_when_limit_plus_one_returned() -> None:
    from app.repositories import search_repository as repo

    db = _RecordingDB(rows_per_call=[[_make_movie(i) for i in range(21)]])
    items, total = await repo.search_movies(db, "alpha", limit=20, offset=0)

    # +1 件は呼び出し側でカット。
    assert len(items) == 20
    # total は offset + len(items) + 1 (= has_more の体裁)
    assert total == 21
    # COUNT 用の追加クエリは出ない
    assert len(db.calls) == 1
    sql = str(db.calls[0])
    # items クエリ自体に LIMIT limit+1 が出ていること
    assert "LIMIT" in sql.upper()


@pytest.mark.asyncio
async def test_search_movies_no_more_when_below_limit() -> None:
    from app.repositories import search_repository as repo

    db = _RecordingDB(rows_per_call=[[_make_movie(i) for i in range(5)]])
    items, total = await repo.search_movies(db, "alpha", limit=20, offset=0)

    assert len(items) == 5
    assert total == 5  # 末尾: offset(0) + len(items)(5)


@pytest.mark.asyncio
async def test_search_movies_total_reflects_offset_on_last_page() -> None:
    from app.repositories import search_repository as repo

    db = _RecordingDB(rows_per_call=[[_make_movie(i) for i in range(7)]])
    items, total = await repo.search_movies(db, "alpha", limit=20, offset=40)

    assert len(items) == 7
    # offset + 取得件数 = 47。next_cursor 計算 (offset+len < total?) で末尾と判定される
    assert total == 47


# ---------------- search_movies_by_exact_field ----------------


@pytest.mark.asyncio
async def test_search_movies_by_exact_field_uses_limit_plus_one() -> None:
    from app.repositories import search_repository as repo

    db = _RecordingDB(rows_per_call=[[_make_movie(i) for i in range(21)]])
    items, total = await repo.search_movies_by_exact_field(
        db, director="監督A", limit=20, offset=0
    )
    assert len(items) == 20
    assert total == 21
    assert len(db.calls) == 1


@pytest.mark.asyncio
async def test_search_movies_by_exact_field_returns_empty_with_no_conditions() -> None:
    from app.repositories import search_repository as repo

    db = _RecordingDB(rows_per_call=[])
    items, total = await repo.search_movies_by_exact_field(db, limit=20)

    assert items == []
    assert total == 0
    # 条件無しなら DB を一切叩かない
    assert db.calls == []


# ---------------- advanced_search_movies ----------------


@pytest.mark.asyncio
async def test_advanced_search_movies_marks_has_more_when_limit_plus_one_returned() -> None:
    from app.repositories import search_repository as repo

    db = _RecordingDB(rows_per_call=[[_make_movie(i) for i in range(21)]])
    items, total = await repo.advanced_search_movies(
        db,
        q="巨乳",
        genres=["巨乳"],
        ng_words=["レズ", "熟女"],
        sort="new",
        limit=20,
        offset=0,
    )
    assert len(items) == 20
    assert total == 21
    # 旧 _capped_count が消えたので execute は items クエリの 1 回だけ
    assert len(db.calls) == 1


@pytest.mark.asyncio
async def test_advanced_search_movies_last_page_has_no_more() -> None:
    from app.repositories import search_repository as repo

    db = _RecordingDB(rows_per_call=[[_make_movie(i) for i in range(20)]])
    items, total = await repo.advanced_search_movies(
        db,
        genres=["巨乳"],
        limit=20,
        offset=0,
    )
    # ちょうど limit 件 → has_more=False、total = len(items)
    assert len(items) == 20
    assert total == 20


@pytest.mark.asyncio
async def test_advanced_search_movies_second_page_offset_consistent() -> None:
    from app.repositories import search_repository as repo

    db = _RecordingDB(rows_per_call=[[_make_movie(i) for i in range(15)]])
    items, total = await repo.advanced_search_movies(
        db,
        genres=["巨乳"],
        limit=20,
        offset=20,
    )
    assert len(items) == 15
    # offset(20) + len(items)(15) = 35
    assert total == 35
