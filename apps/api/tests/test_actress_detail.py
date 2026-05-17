"""女優詳細エンドポイントが goods[] を含むことを確認するテスト。

サービス層をモックで差し替えてレスポンス構造だけ検証する。
"""
from __future__ import annotations

from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.schemas.actress import (
    ActressDetail,
    ActressProfile,
    ActressStats,
    GoodsCard,
)
from app.schemas.movie import MovieCard, PriceList
from app.services import actress_service


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    profile = ActressProfile(
        id=1,
        name="テスト女優",
        slug="test-actress",
        ruby="てすとじょゆう",
        bust=88,
        cup="E",
        waist=58,
        hip=86,
        height=160,
        birthday="1995-01-01",
        blood_type="A",
        prefectures="東京都",
        image_url_small="https://example.com/small.jpg",
        image_url_large="https://example.com/large.jpg",
        dmm_list_url="https://www.dmm.co.jp/digital/videoa/-/list/=/article=actress/id=1/?affiliate=test-001",
    )
    stats = ActressStats(
        movie_count=2,
        total_review_count=10,
        average_review=4.2,
        top_genres=["ジャンルA"],
        top_makers=["メーカーA"],
    )
    movie = MovieCard(
        id="00000000-0000-0000-0000-000000000001",
        content_id="abc00001",
        title="テスト作品",
        slug="test-movie",
        image_url_list="https://example.com/m_list.jpg",
        image_url_large="https://example.com/m_large.jpg",
        affiliate_url="https://example.com/movie",
        price_list=PriceList(sale_price=980),
        price_min=980,
        actresses=["テスト女優"],
        genres=["ジャンルA"],
    )
    goods = GoodsCard(
        id="11111111-1111-1111-1111-111111111111",
        content_id="goods0001",
        title="テストグッズ",
        slug="test-goods",
        image_url_list="https://example.com/g_list.jpg",
        image_url_large="https://example.com/g_large.jpg",
        affiliate_url="https://www.dmm.co.jp/mono/goods/-/detail/=/cid=goods0001/?af_id=test-001",
        price_list=PriceList(list_price=3300),
        price_min=3300,
        review_count=5,
        review_average=4.0,
        maker_name="メーカーA",
    )

    detail = ActressDetail(
        profile=profile,
        stats=stats,
        movies=[movie],
        goods=[goods],
    )

    async def fake_detail(
        db,  # type: ignore[no-untyped-def]
        *,
        name=None,
        slug=None,
        movie_limit=60,
        goods_limit=40,
    ):
        if name == profile.name or slug == profile.slug:
            return detail
        return None

    monkeypatch.setattr(actress_service, "get_actress_detail_service", fake_detail)
    from app.api.v1.endpoints import actresses as actresses_endpoint
    monkeypatch.setattr(
        actresses_endpoint, "get_actress_detail_service", fake_detail
    )

    with TestClient(app) as c:
        yield c


def test_actress_detail_includes_goods(client: TestClient) -> None:
    res = client.get("/api/v1/actresses/テスト女優")
    assert res.status_code == 200
    data = res.json()

    # プロフィール
    assert data["profile"]["name"] == "テスト女優"
    assert data["profile"]["cup"] == "E"
    assert data["profile"]["bust"] == 88

    # 出演作品
    assert len(data["movies"]) == 1
    assert data["movies"][0]["title"] == "テスト作品"

    # 関連商品 (新フィールド)
    assert "goods" in data
    assert len(data["goods"]) == 1
    g = data["goods"][0]
    assert g["title"] == "テストグッズ"
    assert g["price_min"] == 3300
    assert g["maker_name"] == "メーカーA"
    assert g["affiliate_url"].startswith("https://www.dmm.co.jp/mono/goods/")


def test_actress_not_found(client: TestClient) -> None:
    res = client.get("/api/v1/actresses/存在しない女優")
    assert res.status_code == 404
