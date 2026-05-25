"""作品詳細エンドポイントの契約テスト (モックベース)。"""
from __future__ import annotations

from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.schemas.movie import MovieDetail, PriceList
from app.services import movie_service


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    sample_detail = MovieDetail(
        id="00000000-0000-0000-0000-000000000001",
        content_id="abc00001",
        product_id="ABC-001",
        maker_product=None,
        title="テスト作品 001",
        slug="test-movie-001",
        description="テスト説明",
        image_url_list="https://example.com/list.jpg",
        image_url_large="https://example.com/large.jpg",
        sample_embed_url=None,
        affiliate_url="https://www.dmm.co.jp/digital/videoa/-/detail/=/cid=abc00001/?af_id=test-990",
        price_list=PriceList(list_price=1980, sale_price=980),
        price_min=980,
        review_count=10,
        review_average=4.5,
        actresses=["テスト女優"],
        genres=["テストジャンル"],
        series_name=None,
    )

    async def fake_get_movie(db, slug: str):  # type: ignore[no-untyped-def]
        if slug == "test-movie-001":
            return sample_detail
        return None

    monkeypatch.setattr(
        movie_service, "get_movie_by_slug_service", fake_get_movie
    )
    from app.api.v1.endpoints import movies as movies_endpoint

    monkeypatch.setattr(
        movies_endpoint, "get_movie_by_slug_service", fake_get_movie
    )
    yield TestClient(app)


def test_read_movie_detail_returns_actual_schema(client: TestClient) -> None:
    response = client.get("/api/v1/movies/test-movie-001")
    assert response.status_code == 200
    data = response.json()
    assert data["slug"] == "test-movie-001"
    assert data["title"] == "テスト作品 001"
    assert "affiliate_url" in data
    # MovieDetail で定義されているフィールド (旧 thumbnail_url ではない)
    assert "image_url_large" in data
    assert "image_url_list" in data


def test_read_movie_detail_not_found(client: TestClient) -> None:
    response = client.get("/api/v1/movies/does-not-exist")
    assert response.status_code == 404
    assert response.json() == {"detail": "Movie not found"}
