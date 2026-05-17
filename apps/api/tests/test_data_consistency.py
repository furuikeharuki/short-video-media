"""feed と詳細エンドポイントが共通スキーマ (MovieCard / MovieDetail) で整合することを確認する。

実 DB を立てずに、サービス層をモックで差し替えて主要キーが一致することだけを検証する。
"""
from __future__ import annotations

from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.schemas.feed import FeedResponse
from app.schemas.movie import MovieCard, MovieDetail, PriceList
from app.services import feed_service, movie_service


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    card = MovieCard(
        id="00000000-0000-0000-0000-000000000001",
        content_id="abc00001",
        title="テスト作品 001",
        slug="test-movie-001",
        image_url_list="https://example.com/list.jpg",
        image_url_large="https://example.com/large.jpg",
        affiliate_url="https://www.dmm.co.jp/digital/videoa/-/detail/=/cid=abc00001/?af_id=test-990",
        price_list=PriceList(list_price=1980, sale_price=980),
        price_min=980,
        actresses=["テスト女優"],
        genres=["テストジャンル"],
    )
    detail = MovieDetail(
        id=card.id,
        content_id=card.content_id,
        title=card.title,
        slug=card.slug,
        image_url_list=card.image_url_list,
        image_url_large=card.image_url_large,
        affiliate_url=card.affiliate_url,
        price_list=card.price_list,
        price_min=card.price_min,
        actresses=card.actresses,
        genres=card.genres,
    )

    async def fake_feed(*args, **kwargs):  # type: ignore[no-untyped-def]
        return FeedResponse(items=[card], next_cursor=None)

    async def fake_detail(db, slug: str):  # type: ignore[no-untyped-def]
        return detail if slug == card.slug else None

    monkeypatch.setattr(feed_service, "get_feed_paginated", fake_feed)
    monkeypatch.setattr(
        movie_service, "get_movie_by_slug_service", fake_detail
    )
    from app.api.v1.endpoints import feed as feed_endpoint
    from app.api.v1.endpoints import movies as movies_endpoint

    monkeypatch.setattr(feed_endpoint, "get_feed_paginated", fake_feed)
    monkeypatch.setattr(movies_endpoint, "get_movie_by_slug_service", fake_detail)
    yield TestClient(app)


def test_feed_and_detail_share_keys(client: TestClient) -> None:
    feed_response = client.get("/api/v1/feed")
    assert feed_response.status_code == 200
    feed_data = feed_response.json()
    item = feed_data["items"][0]

    detail_response = client.get(f"/api/v1/movies/{item['slug']}")
    assert detail_response.status_code == 200
    detail_data = detail_response.json()

    # feed と detail で同一の作品を表しているなら、共通フィールドが一致する
    for key in ("id", "title", "slug", "image_url_large", "image_url_list",
                "affiliate_url", "actresses", "genres"):
        assert detail_data[key] == item[key], f"mismatch on {key}"
