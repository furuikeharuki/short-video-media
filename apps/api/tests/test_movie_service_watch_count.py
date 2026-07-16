"""movie_service.get_movie_by_slug_service が watch_count を MovieDetail に
載せて返すこと、集計失敗時は None になることを担保する。
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.services import movie_service


def _movie(slug: str):
    return SimpleNamespace(
        id="00000000-0000-0000-0000-000000000001",
        content_id="abc00001",
        product_id="ABC-001",
        maker_product=None,
        title=f"title {slug}",
        slug=slug,
        description="desc",
        dmm_description=None,
        volume=None,
        image_url_list=None,
        image_url_large=None,
        sample_embed_url=None,
        affiliate_url="https://example.com/x",
        price_list=None,
        price_min=None,
        release_date=None,
        delivery_date=None,
        rental_start_date=None,
        primary_date=None,
        review_count=0,
        review_average=None,
        director_name=None,
        label_name=None,
        maker_name=None,
        actresses=[],
        genres=[],
        series=None,
    )


def _disable_redis(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(movie_service, "get_redis", lambda: None)


def test_get_movie_by_slug_service_attaches_watch_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """interaction_event_repository.get_watch_count_for_slug の値が
    MovieDetail.watch_count に反映される。
    """
    _disable_redis(monkeypatch)
    target = _movie("slug-a")

    async def fake_get_movie(db, slug):  # type: ignore[no-untyped-def]
        assert slug == "slug-a"
        return target

    async def fake_watch(db, slug):  # type: ignore[no-untyped-def]
        return 42

    monkeypatch.setattr(movie_service, "get_movie_by_slug", fake_get_movie)
    monkeypatch.setattr(movie_service, "get_watch_count_for_slug", fake_watch)

    out = asyncio.run(movie_service.get_movie_by_slug_service(None, "slug-a"))  # type: ignore[arg-type]
    assert out is not None
    assert out.watch_count == 42


def test_get_movie_by_slug_service_watch_count_none_on_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """watch_count の集計が例外を投げても詳細は返り、watch_count は None になる。

    SEO 用 interactionStatistic を捏造しないために、失敗時は明示的に None を
    返す方針を担保する。
    """
    _disable_redis(monkeypatch)
    target = _movie("slug-a")

    async def fake_get_movie(db, slug):  # type: ignore[no-untyped-def]
        return target

    async def boom(db, slug):  # type: ignore[no-untyped-def]
        raise RuntimeError("simulated aggregation failure")

    monkeypatch.setattr(movie_service, "get_movie_by_slug", fake_get_movie)
    monkeypatch.setattr(movie_service, "get_watch_count_for_slug", boom)

    out = asyncio.run(movie_service.get_movie_by_slug_service(None, "slug-a"))  # type: ignore[arg-type]
    assert out is not None
    assert out.watch_count is None
