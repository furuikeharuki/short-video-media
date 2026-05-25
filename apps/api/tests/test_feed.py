"""/api/v1/feed の契約テスト。

実 DB が無くても通るように、`get_feed_paginated` をモックで差し替える。
スキーマ (MovieCard) と feed エンドポイントが提供するキーが一致することを保証する。
"""
from __future__ import annotations

from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.schemas.feed import FeedResponse
from app.schemas.movie import MovieCard, PriceList
from app.services import feed_service


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    sample_card = MovieCard(
        id="00000000-0000-0000-0000-000000000001",
        content_id="abc00001",
        title="テスト作品 001",
        slug="test-movie-001",
        image_url_list="https://example.com/list.jpg",
        image_url_large="https://example.com/large.jpg",
        affiliate_url="https://www.dmm.co.jp/digital/videoa/-/detail/=/cid=abc00001/?af_id=test-990",
        price_list=PriceList(list_price=1980, sale_price=980),
        price_min=980,
        review_count=10,
        review_average=4.5,
        actresses=["テスト女優"],
        genres=["テストジャンル"],
        series_name=None,
    )

    async def fake_get_feed_paginated(*args, **kwargs):  # type: ignore[no-untyped-def]
        return FeedResponse(items=[sample_card], next_cursor=None)

    monkeypatch.setattr(feed_service, "get_feed_paginated", fake_get_feed_paginated)
    # endpoint がモジュール直下で import している参照も差し替え
    from app.api.v1.endpoints import feed as feed_endpoint

    monkeypatch.setattr(feed_endpoint, "get_feed_paginated", fake_get_feed_paginated)
    yield TestClient(app)


def test_feed_returns_items(client: TestClient) -> None:
    response = client.get("/api/v1/feed")
    assert response.status_code == 200
    data = response.json()
    assert "items" in data and isinstance(data["items"], list)
    assert "next_cursor" in data
    assert len(data["items"]) >= 1


def test_feed_item_uses_actual_movie_card_schema(client: TestClient) -> None:
    """MovieCard で定義した実フィールドだけが返ることを確認する。

    旧テストは `thumbnail_url` / `sample_embed_url` を期待していたが、
    現状のスキーマには存在しないので失敗する。
    """
    response = client.get("/api/v1/feed")
    data = response.json()
    item = data["items"][0]

    # MovieCard で定義されているフィールド
    for required_key in (
        "id",
        "title",
        "slug",
        "image_url_list",
        "image_url_large",
        "affiliate_url",
        "actresses",
        "genres",
    ):
        assert required_key in item, f"missing required key in feed item: {required_key}"

    assert isinstance(item["id"], str)
    assert isinstance(item["title"], str)
    assert isinstance(item["slug"], str)
    assert isinstance(item["affiliate_url"], str)
    assert isinstance(item["actresses"], list)
    assert isinstance(item["genres"], list)
