"""movie_service.get_movie_by_slug_service の dmm_keywords write-on-read 補完。

dmm_description があり dmm_keywords が未設定のとき、その場で抽出して
DB に保存し、MovieDetail にも載せて返すことを担保する。抽出/保存が
失敗してもレスポンスは返る (best-effort) ことも確認する。
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.services import movie_service


def _movie(slug: str, *, dmm_description=None, dmm_keywords=None):
    return SimpleNamespace(
        id="00000000-0000-0000-0000-000000000001",
        content_id="abc00001",
        product_id="ABC-001",
        maker_product=None,
        title=f"title {slug}",
        slug=slug,
        description="desc",
        dmm_description=dmm_description,
        dmm_keywords=dmm_keywords,
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


class _FakeDB:
    def __init__(self) -> None:
        self.executed = False
        self.committed = False

    async def execute(self, *_args, **_kwargs) -> None:
        self.executed = True

    async def commit(self) -> None:
        self.committed = True

    async def rollback(self) -> None:  # pragma: no cover - not expected here
        pass


def _setup(monkeypatch: pytest.MonkeyPatch, movie) -> None:
    monkeypatch.setattr(movie_service, "get_redis", lambda: None)

    async def fake_get_movie(db, slug):  # type: ignore[no-untyped-def]
        return movie

    async def fake_watch(db, slug):  # type: ignore[no-untyped-def]
        return None

    monkeypatch.setattr(movie_service, "get_movie_by_slug", fake_get_movie)
    monkeypatch.setattr(movie_service, "get_watch_count_for_slug", fake_watch)


def test_backfills_keywords_on_read(monkeypatch: pytest.MonkeyPatch) -> None:
    movie = _movie(
        "slug-a",
        dmm_description="人気メンズエステ店に潜入したドキュメンタリー。エステ体験の施術映像。",
        dmm_keywords=None,
    )
    _setup(monkeypatch, movie)
    db = _FakeDB()

    out = asyncio.run(movie_service.get_movie_by_slug_service(db, "slug-a"))
    assert out is not None
    assert out.dmm_keywords, "キーワードが補完されていない"
    assert "エステ" in out.dmm_keywords
    assert db.executed and db.committed, "DB への write-on-read が実行されていない"


def test_no_backfill_when_keywords_present(monkeypatch: pytest.MonkeyPatch) -> None:
    movie = _movie(
        "slug-b",
        dmm_description="説明文あり",
        dmm_keywords=["既存", "キーワード"],
    )
    _setup(monkeypatch, movie)
    db = _FakeDB()

    out = asyncio.run(movie_service.get_movie_by_slug_service(db, "slug-b"))
    assert out is not None
    assert out.dmm_keywords == ["既存", "キーワード"]
    assert not db.executed, "既にキーワードがあるのに DB を更新している"


def test_no_backfill_without_description(monkeypatch: pytest.MonkeyPatch) -> None:
    movie = _movie("slug-c", dmm_description=None, dmm_keywords=None)
    _setup(monkeypatch, movie)
    db = _FakeDB()

    out = asyncio.run(movie_service.get_movie_by_slug_service(db, "slug-c"))
    assert out is not None
    assert out.dmm_keywords == []
    assert not db.executed
