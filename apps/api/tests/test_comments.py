"""/api/v1/movies/{slug}/comments と /api/v1/me/display-name のテスト。

実 DB に接続せず、`require_user` と `get_db` を dependency_overrides で差し替えて
in-memory dict ストアでハンドラの分岐を検証する。

確認するシナリオ:
  - movie が見つからないなら 404
  - 未ログインで投稿しようとすると 401
  - 表示名未設定ユーザーが投稿すると snapshot が「名無しのユーザー」になる
  - 表示名を更新したあとに投稿すると snapshot が新表示名になる (履歴は古いコメントごとに固定)
  - 返信 (parent_id) は 1 段だけ可。返信への返信は 400
  - 他人のコメントは削除できない (403)。自分のコメントは 204
  - GET は root → 返信を埋め込んで返す (新しい順)
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.core.security import require_user
from app.db.session import get_db
from app.main import app


# ---------- 共通ヘルパー ----------


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class _Row:
    """SQLAlchemy の Row っぽい振る舞いをするだけのコンテナ。"""

    def __init__(self, value: Any) -> None:
        self._value = value

    def scalar_one(self) -> Any:
        return self._value

    def scalar_one_or_none(self) -> Any:
        return self._value


class _Scalars:
    def __init__(self, items: list[Any]) -> None:
        self._items = items

    def all(self) -> list[Any]:
        return list(self._items)


class _ResultWithScalars:
    def __init__(self, items: list[Any]) -> None:
        self._items = items

    def scalars(self) -> _Scalars:
        return _Scalars(self._items)


class _FakeStore:
    """テスト用の最小 in-memory DB スタブ。

    - movies: dict[slug, movie_id]
    - users: dict[user_id, dict("display_name" -> str|None)]
    - comments: dict[id, dict]
    """

    def __init__(self) -> None:
        self.movies: dict[str, str] = {}
        self.users: dict[str, dict[str, Any]] = {}
        self.comments: dict[str, dict[str, Any]] = {}

    def add_movie(self, slug: str) -> str:
        movie_id = str(uuid.uuid4())
        self.movies[slug] = movie_id
        return movie_id

    def add_user(self, user_id: str, display_name: str | None = None) -> None:
        self.users.setdefault(user_id, {"id": user_id, "display_name": display_name})


class _FakeUser:
    """SQLAlchemy User の最小スタブ。属性アクセス + 代入で displayName を変える。"""

    def __init__(self, store: _FakeStore, user_id: str) -> None:
        self._store = store
        self.id = user_id

    @property
    def display_name(self) -> str | None:
        return self._store.users[self.id]["display_name"]

    @display_name.setter
    def display_name(self, value: str | None) -> None:
        self._store.users[self.id]["display_name"] = value


class _FakeDB:
    """endpoints/comments.py が使う SQLAlchemy 構文を最小限スタブする。

    実装ガイド: stmt をコンパイル → SQL 文字列を見て分岐する。
    """

    def __init__(self, store: _FakeStore, user: _FakeUser | None) -> None:
        self.store = store
        self.user = user
        self._pending_add: list[Any] = []
        self._refresh_targets: list[Any] = []

    async def execute(self, stmt: Any) -> Any:  # noqa: ANN001
        from sqlalchemy.sql.dml import Delete

        if isinstance(stmt, Delete):
            sql = str(stmt.compile(compile_kwargs={"literal_binds": True}))
            # 例: DELETE FROM comments WHERE comments.id = 'abc'
            import re

            m = re.search(r"comments\.id\s*=\s*'([^']+)'", sql)
            if m:
                self.store.comments.pop(m.group(1), None)
            return _Row(None)

        sql = str(stmt.compile(compile_kwargs={"literal_binds": True}))

        # SELECT count(*) FROM comments WHERE movie_id = X AND parent_id IS NULL
        if "count(" in sql.lower() and "comments" in sql.lower():
            import re

            m = re.search(r"movie_id\s*=\s*'([^']+)'", sql)
            movie_id = m.group(1) if m else None
            return _Row(
                sum(
                    1
                    for c in self.store.comments.values()
                    if c["movie_id"] == movie_id and c["parent_id"] is None
                )
            )

        # SELECT movies.id FROM movies WHERE movies.slug = X
        if "movies.slug" in sql and "movies.id" in sql:
            import re

            m = re.search(r"slug\s*=\s*'([^']+)'", sql)
            slug = m.group(1) if m else None
            return _Row(self.store.movies.get(slug))

        # SELECT comments.* FROM comments WHERE movie_id = X AND parent_id IS NULL ORDER BY created_at DESC
        if "comments" in sql.lower() and "parent_id is null" in sql.lower():
            import re

            m = re.search(r"movie_id\s*=\s*'([^']+)'", sql)
            movie_id = m.group(1) if m else None
            roots = [
                _FakeCommentRow(c)
                for c in self.store.comments.values()
                if c["movie_id"] == movie_id and c["parent_id"] is None
            ]
            roots.sort(key=lambda c: (c.created_at, c.id), reverse=True)
            return _ResultWithScalars(roots)

        # SELECT comments.* WHERE parent_id IN (...)
        if "comments" in sql.lower() and "parent_id in" in sql.lower():
            import re

            ids = re.findall(r"'([0-9a-f-]{36})'", sql)
            replies = [
                _FakeCommentRow(c)
                for c in self.store.comments.values()
                if c["parent_id"] in ids
            ]
            replies.sort(key=lambda c: (c.created_at, c.id))
            return _ResultWithScalars(replies)

        # SELECT comments.* WHERE id = X AND movie_id = X (parent lookup)
        if (
            "comments" in sql.lower()
            and "comments.id" in sql.lower()
            and "movie_id" in sql.lower()
        ):
            import re

            cid_m = re.search(r"comments\.id\s*=\s*'([^']+)'", sql)
            mid_m = re.search(r"movie_id\s*=\s*'([^']+)'", sql)
            if cid_m and mid_m:
                cid = cid_m.group(1)
                mid = mid_m.group(1)
                rec = self.store.comments.get(cid)
                if rec and rec["movie_id"] == mid:
                    return _Row(_FakeCommentRow(rec))
                return _Row(None)

        # SELECT comments.* WHERE id = X (single)
        if "comments" in sql.lower() and "comments.id" in sql.lower():
            import re

            m = re.search(r"comments\.id\s*=\s*'([^']+)'", sql)
            cid = m.group(1) if m else None
            rec = self.store.comments.get(cid)
            return _Row(_FakeCommentRow(rec) if rec else None)

        return _Row(None)

    def add(self, obj: Any) -> None:
        # Comment / User の保存
        if obj.__class__.__name__ == "Comment":
            cid = obj.id or str(uuid.uuid4())
            obj.id = cid
            rec = {
                "id": cid,
                "movie_id": obj.movie_id,
                "parent_id": obj.parent_id,
                "author_user_id": obj.author_user_id,
                "display_name_snapshot": obj.display_name_snapshot,
                "body": obj.body,
                "created_at": obj.created_at or _utcnow(),
            }
            self.store.comments[cid] = rec
            self._pending_add.append(obj)
        # User オブジェクトは _FakeUser なので setter で既に store 更新済み。
        # SQLAlchemy User 用の add は no-op で OK。

    async def commit(self) -> None:
        return None

    async def refresh(self, obj: Any) -> None:
        # Comment の値はテストでは _pending_add のものでそのまま使えるので no-op で十分。
        return None


class _FakeCommentRow:
    """endpoints/comments.py が直接属性アクセスする Comment 模擬オブジェクト。"""

    def __init__(self, rec: dict[str, Any]) -> None:
        self.id = rec["id"]
        self.movie_id = rec["movie_id"]
        self.parent_id = rec["parent_id"]
        self.author_user_id = rec["author_user_id"]
        self.display_name_snapshot = rec["display_name_snapshot"]
        self.body = rec["body"]
        self.created_at = rec["created_at"]


# ---------- fixture / client builder ----------


@pytest.fixture
def store() -> _FakeStore:
    return _FakeStore()


@pytest.fixture(autouse=True)
def _clear_overrides() -> Iterator[None]:
    yield
    app.dependency_overrides.clear()


def _make_client(
    store: _FakeStore, user_id: str | None, *, display_name: str | None = None
) -> TestClient:
    if user_id is not None:
        store.add_user(user_id, display_name)
        fake_user = _FakeUser(store, user_id)

        async def _user() -> _FakeUser:
            return fake_user

        app.dependency_overrides[require_user] = _user

        async def _fake_db():
            yield _FakeDB(store, fake_user)

    else:
        async def _fake_db():
            yield _FakeDB(store, None)

    app.dependency_overrides[get_db] = _fake_db
    return TestClient(app)


# ---------- テスト本体 ----------


def test_list_returns_404_for_unknown_slug(store: _FakeStore) -> None:
    client = _make_client(store, user_id=None)
    res = client.get("/api/v1/movies/unknown-slug/comments")
    assert res.status_code == 404


def test_create_requires_auth(store: _FakeStore) -> None:
    store.add_movie("movie-1")
    app.dependency_overrides.clear()
    client = TestClient(app)
    res = client.post(
        "/api/v1/movies/movie-1/comments", json={"body": "hello"}
    )
    assert res.status_code == 401


def test_create_uses_default_display_name(store: _FakeStore) -> None:
    """display_name 未設定ユーザーの投稿は snapshot が「名無しのユーザー」になる。"""
    store.add_movie("movie-1")
    client = _make_client(store, "user-A", display_name=None)
    res = client.post(
        "/api/v1/movies/movie-1/comments", json={"body": "first!"}
    )
    assert res.status_code == 201
    data = res.json()
    assert data["display_name"] == "名無しのユーザー"
    assert data["body"] == "first!"
    assert data["parent_id"] is None
    assert data["replies"] == []


def test_display_name_update_then_post_uses_new_name(store: _FakeStore) -> None:
    store.add_movie("movie-1")
    client = _make_client(store, "user-A", display_name=None)
    # 1) 初期は「名無しのユーザー」
    res = client.get("/api/v1/me/display-name")
    assert res.status_code == 200
    assert res.json()["display_name"] == "名無しのユーザー"

    # 2) 表示名を更新
    res = client.put("/api/v1/me/display-name", json={"display_name": "アリス"})
    assert res.status_code == 200
    assert res.json()["display_name"] == "アリス"

    # 3) 新しいコメントは snapshot が「アリス」
    res = client.post("/api/v1/movies/movie-1/comments", json={"body": "hi"})
    assert res.status_code == 201
    assert res.json()["display_name"] == "アリス"


def test_reply_to_top_level_ok_but_reply_to_reply_400(store: _FakeStore) -> None:
    store.add_movie("movie-1")
    client = _make_client(store, "user-A", display_name="アリス")
    # root
    root = client.post(
        "/api/v1/movies/movie-1/comments", json={"body": "root"}
    ).json()
    # 返信 OK
    reply = client.post(
        "/api/v1/movies/movie-1/comments",
        json={"body": "reply", "parent_id": root["id"]},
    )
    assert reply.status_code == 201
    # 返信への返信 → 400
    res = client.post(
        "/api/v1/movies/movie-1/comments",
        json={"body": "nope", "parent_id": reply.json()["id"]},
    )
    assert res.status_code == 400


def test_list_embeds_replies_in_thread(store: _FakeStore) -> None:
    store.add_movie("movie-1")
    client = _make_client(store, "user-A", display_name="アリス")
    root = client.post(
        "/api/v1/movies/movie-1/comments", json={"body": "root"}
    ).json()
    client.post(
        "/api/v1/movies/movie-1/comments",
        json={"body": "r1", "parent_id": root["id"]},
    )
    client.post(
        "/api/v1/movies/movie-1/comments",
        json={"body": "r2", "parent_id": root["id"]},
    )
    listed = client.get("/api/v1/movies/movie-1/comments").json()
    assert listed["total"] == 1
    assert len(listed["items"]) == 1
    item = listed["items"][0]
    assert item["body"] == "root"
    assert [r["body"] for r in item["replies"]] == ["r1", "r2"]


def test_cannot_delete_others_comment(store: _FakeStore) -> None:
    store.add_movie("movie-1")
    # user-A が投稿
    client_a = _make_client(store, "user-A", display_name="A")
    root = client_a.post(
        "/api/v1/movies/movie-1/comments", json={"body": "mine"}
    ).json()

    # user-B が削除 → 403
    app.dependency_overrides.clear()
    client_b = _make_client(store, "user-B", display_name="B")
    res = client_b.delete(f"/api/v1/comments/{root['id']}")
    assert res.status_code == 403
    # まだ残っている
    assert root["id"] in store.comments


def test_owner_can_delete_own_comment(store: _FakeStore) -> None:
    store.add_movie("movie-1")
    client = _make_client(store, "user-A", display_name="A")
    root = client.post(
        "/api/v1/movies/movie-1/comments", json={"body": "delete me"}
    ).json()
    res = client.delete(f"/api/v1/comments/{root['id']}")
    assert res.status_code == 204
    assert root["id"] not in store.comments


def test_display_name_empty_string_resets_to_default(store: _FakeStore) -> None:
    client = _make_client(store, "user-A", display_name="アリス")
    res = client.put("/api/v1/me/display-name", json={"display_name": "   "})
    assert res.status_code == 200
    # 空白だけは「名無しのユーザー」相当 (内部的には NULL)
    assert res.json()["display_name"] == "名無しのユーザー"
