"""POST /api/v1/interaction-events のテスト。

DB を `dependency_overrides` でフェイクに差し替え、ハンドラの入口バリデーション
(allowed event_name / metadata 上限 / repository 呼び出し) のみ検証する。
"""
from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.db.session import get_db
from app.main import app


class _FakeDb:
    """`add` / `commit` だけ受ければ良いフェイクセッション。"""

    def __init__(self) -> None:
        self.added: list[Any] = []
        self.commits: int = 0

    def add(self, obj: Any) -> None:
        self.added.append(obj)

    async def commit(self) -> None:
        self.commits += 1


@pytest.fixture()
def fake_db() -> Iterator[_FakeDb]:
    db = _FakeDb()

    async def _override() -> Any:
        yield db

    app.dependency_overrides[get_db] = _override
    try:
        yield db
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_accepts_known_event(fake_db: _FakeDb) -> None:
    client = TestClient(app)
    resp = client.post(
        "/api/v1/interaction-events",
        json={
            "event_name": "play",
            "slug": "abc-123",
            "feed_session_id": "feed_test_1",
            "feed_position": 0,
            "session_seq": 1,
            "surface": "home",
            "rec_source": "ranking_daily",
            "progress_ratio": 0.0,
            "current_time_sec": 0.0,
            "duration_sec": 120.0,
            "elapsed_ms": 0,
            "metadata": {"muted": True},
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True}
    assert len(fake_db.added) == 1
    inserted = fake_db.added[0]
    assert inserted.event_name == "play"
    assert inserted.slug == "abc-123"
    assert inserted.feed_session_id == "feed_test_1"
    assert inserted.event_metadata == {"muted": True}


def test_rejects_unknown_event(fake_db: _FakeDb) -> None:
    client = TestClient(app)
    resp = client.post(
        "/api/v1/interaction-events",
        json={"event_name": "definitely_not_an_event"},
    )
    assert resp.status_code == 400
    assert "invalid event_name" in resp.text
    assert fake_db.added == []


def test_rejects_oversized_metadata(fake_db: _FakeDb) -> None:
    client = TestClient(app)
    big_meta = {f"k{i}": i for i in range(64)}  # 32 件超
    resp = client.post(
        "/api/v1/interaction-events",
        json={"event_name": "play", "slug": "abc", "metadata": big_meta},
    )
    assert resp.status_code == 400
    assert "metadata too large" in resp.text
    assert fake_db.added == []


def test_progress_ratio_bounds(fake_db: _FakeDb) -> None:
    client = TestClient(app)
    # 1.0 超は pydantic で 422
    resp = client.post(
        "/api/v1/interaction-events",
        json={"event_name": "play_progress", "slug": "abc", "progress_ratio": 1.5},
    )
    assert resp.status_code == 422
    assert fake_db.added == []


def test_milestone_progression(fake_db: _FakeDb) -> None:
    client = TestClient(app)
    for milestone in (25, 50, 75, 100):
        resp = client.post(
            "/api/v1/interaction-events",
            json={
                "event_name": "play_progress",
                "slug": "abc",
                "progress_milestone": milestone,
                "progress_ratio": milestone / 100.0,
            },
        )
        assert resp.status_code == 200, resp.text
    assert [e.progress_milestone for e in fake_db.added] == [25, 50, 75, 100]
