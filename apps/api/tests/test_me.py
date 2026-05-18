"""/api/v1/me/search-prefs のテスト。

実 DB に接続せず、`require_user` と `get_db` を dependency_overrides で差し替えて
シンプルな in-memory dict ストアでハンドラの分岐 (GET 未保存→全 None、PUT→GET 復元、
別ユーザー分離) を検証する。

メソッドが実行する SQL ステートメントの種類は限られているので、SQLAlchemy ORM の
個別構文 (select / pg_insert.on_conflict_do_update) を眺めて分岐する fake session を作る。
"""
from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.api.v1.endpoints import me as me_endpoint
from app.core.security import require_user
from app.db.session import get_db
from app.main import app


class _FakePrefDB:
    """search-prefs 用の最小スタブ。

    - `select(UserSearchPref.payload).where(user_id == X)` → scalar_one_or_none で payload
    - `pg_insert(UserSearchPref).on_conflict_do_update(...)` → store[user_id] = payload
    実装は __visit_name__ や compile を見るのではなく、bind 済みパラメータから user_id を
    取り出すという形にする (SQLAlchemy 内部に依存しすぎないように)。
    """

    def __init__(self, store: dict[str, dict]) -> None:
        self.store = store
        self._committed = False

    async def execute(self, stmt: Any):  # noqa: ANN001
        store = self.store

        # pg_insert (.on_conflict_do_update) は Insert 文。values で user_id と payload を渡している
        from sqlalchemy.dialects.postgresql.dml import Insert as PgInsert

        if isinstance(stmt, PgInsert):
            params = stmt.compile().params
            user_id = params.get("user_id")
            payload = params.get("payload")
            if user_id is not None:
                store[user_id] = payload if payload is not None else {}

            class _R:
                def scalar_one_or_none(self):
                    return None

                def all(self):
                    return []

            return _R()

        # select 系: where 句から user_id を拾って store を引く
        # 一番手早いのは文字列化して user_id 値を見る方法だが、テストでは
        # stmt.compile(compile_kwargs={"literal_binds": True}) を使う
        compiled = stmt.compile(compile_kwargs={"literal_binds": True})
        sql = str(compiled)
        # "user_id = 'XXX'" を抜き出す
        import re

        m = re.search(r"user_id\s*=\s*'([^']+)'", sql)
        user_id = m.group(1) if m else None
        payload = store.get(user_id) if user_id is not None else None

        class _R:
            def scalar_one_or_none(self):
                return payload

            def all(self):
                return []

        return _R()

    async def commit(self) -> None:
        self._committed = True


@pytest.fixture
def store() -> dict[str, dict]:
    return {}


def _make_client(store: dict[str, dict], user_id: str) -> TestClient:
    class _U:
        id = user_id

    async def _user():
        return _U()

    async def _fake_db():
        yield _FakePrefDB(store)

    app.dependency_overrides[require_user] = _user
    app.dependency_overrides[get_db] = _fake_db
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clear_overrides() -> Iterator[None]:
    yield
    app.dependency_overrides.clear()


def test_get_when_unsaved_returns_all_none(store: dict[str, dict]) -> None:
    client = _make_client(store, "user-A")
    res = client.get("/api/v1/me/search-prefs")
    assert res.status_code == 200
    data = res.json()
    # 全フィールド None
    for k in (
        "q",
        "genres",
        "actresses",
        "series_list",
        "directors",
        "makers",
        "labels",
        "ng_words",
        "date_from",
        "date_to",
        "sort",
    ):
        assert data[k] is None


def test_put_then_get_roundtrip(store: dict[str, dict]) -> None:
    client = _make_client(store, "user-A")
    body = {
        "q": "テスト",
        "genres": ["G1", "G2"],
        "actresses": ["A1"],
        "series_list": None,
        "directors": [],
        "makers": None,
        "labels": None,
        "ng_words": ["NG1", "NG2"],
        "date_from": "2025-01-01",
        "date_to": "2025-12-31",
        "sort": "popular",
    }
    res = client.put("/api/v1/me/search-prefs", json=body)
    assert res.status_code == 200
    assert res.json() == body

    # 続けて GET で復元できる
    res2 = client.get("/api/v1/me/search-prefs")
    assert res2.status_code == 200
    got = res2.json()
    for k, v in body.items():
        assert got[k] == v


def test_users_are_isolated(store: dict[str, dict]) -> None:
    """user-A が保存しても user-B には見えない。"""
    client_a = _make_client(store, "user-A")
    res = client_a.put(
        "/api/v1/me/search-prefs",
        json={"q": "A だけが見るやつ", "sort": "new"},
    )
    assert res.status_code == 200

    # user-B に切替え (overrides を作り直す)
    app.dependency_overrides.clear()
    client_b = _make_client(store, "user-B")
    res_b = client_b.get("/api/v1/me/search-prefs")
    assert res_b.status_code == 200
    data_b = res_b.json()
    assert data_b["q"] is None
    assert data_b["sort"] is None

    # user-A 側に戻すと残っている
    app.dependency_overrides.clear()
    client_a2 = _make_client(store, "user-A")
    res_a2 = client_a2.get("/api/v1/me/search-prefs")
    assert res_a2.status_code == 200
    assert res_a2.json()["q"] == "A だけが見るやつ"


def test_unauthorized_without_override(monkeypatch: pytest.MonkeyPatch) -> None:
    """Authorization なしで叩くと 401 (require_user の挙動を確認)。"""
    # dependency_overrides をクリアし、純粋な require_user を経由させる
    app.dependency_overrides.clear()
    client = TestClient(app)
    res = client.get("/api/v1/me/search-prefs")
    assert res.status_code == 401
