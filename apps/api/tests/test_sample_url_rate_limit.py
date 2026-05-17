"""POST /movies/{slug}/sample-url のレート制限テスト。

実 DB は使わず、Movie 更新クエリを monkeypatch でバイパスする。
レート制限は in-memory なので、テスト内では Settings を上書きして
低い閾値 (per_second=2, per_minute=4) のリミッタを inject する。
"""
from __future__ import annotations

from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from app.core.rate_limit import EventRateLimiter, get_sample_url_rate_limiter
from app.db.session import get_db
from app.main import app

VALID_URL = (
    "https://cc3001.dmm.co.jp/litevideo/freepv/n/nas/nask00405/nask00405_mhb_w.mp4"
)


class _FakeResult:
    rowcount = 1


class _FakeSession:
    async def execute(self, *_args, **_kwargs):  # type: ignore[no-untyped-def]
        return _FakeResult()

    async def commit(self) -> None:
        return None


async def _fake_get_db():  # type: ignore[no-untyped-def]
    yield _FakeSession()


@pytest.fixture
def client() -> Iterator[TestClient]:
    # DB セッションを FastAPI の dependency_overrides で差し替え
    app.dependency_overrides[get_db] = _fake_get_db
    # 低い閾値で専用リミッタを注入 (per_second=2, per_minute=4)
    limiter = EventRateLimiter(per_second=2, per_minute=4)
    app.dependency_overrides[get_sample_url_rate_limiter] = lambda: limiter
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_sample_url_rate_limiter, None)
        app.dependency_overrides.pop(get_db, None)


def test_sample_url_accepts_within_limit(client: TestClient) -> None:
    """1 秒上限 (2) の範囲内なら 2xx が返る。"""
    r1 = client.post(
        "/api/v1/movies/test-slug/sample-url",
        json={"sample_movie_url": VALID_URL},
    )
    r2 = client.post(
        "/api/v1/movies/test-slug/sample-url",
        json={"sample_movie_url": VALID_URL},
    )
    # DB を bypass しているので 200 が期待値
    assert r1.status_code == 200, r1.text
    assert r2.status_code == 200, r2.text


def test_sample_url_rate_limit_blocks_burst(client: TestClient) -> None:
    """1 分上限 (4) を超えると 429 を返す。"""
    last_status: int | None = None
    for _ in range(10):
        resp = client.post(
            "/api/v1/movies/test-slug/sample-url",
            json={"sample_movie_url": VALID_URL},
        )
        last_status = resp.status_code
        if resp.status_code == 429:
            break
    assert last_status == 429, f"expected 429 within burst, got {last_status}"
