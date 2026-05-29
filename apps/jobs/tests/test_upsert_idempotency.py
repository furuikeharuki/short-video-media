"""upsert の idempotency と SAVEPOINT ロールバック後のキャッシュ整合性をテストする。

ここで再現するシナリオ:

1. **重複 slug**: DB に既に slug="ai-japan-4279762" の Series が別 content_id で存在
   する状態で、同名・同 series_id の作品を upsert しても UNIQUE 違反でジョブが
   止まらず、既存行を再利用すること。Actress も同じ。

2. **重複 content_id**: 並行ジョブ等で同じ content_id の Movie が既に DB にある
   場合、INSERT 時の UNIQUE 違反 を捕捉して update 扱いに切り替えること。

3. **失敗 item の後でもキャッシュが汚染されない**: 1 件の SAVEPOINT 失敗後でも
   次の item を upsert できること (greenlet_spawn / stale-cache 起因のエラーが
   発生しないこと)。
"""
from __future__ import annotations

import asyncio
import sys
import uuid
from pathlib import Path

# JSONB は conftest.py で JSON に差し替え済み (SQLite テスト用)。

# apps/api と apps/jobs/src を import パスに追加
_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[3] / "apps" / "api"))
sys.path.insert(0, str(_HERE.parents[1]))

from sqlalchemy import select  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from app.db.base import Base  # noqa: E402
from app.db.models.actress import Actress  # noqa: E402
from app.db.models.movie import Movie  # noqa: E402
from app.db.models.series import Series  # noqa: E402
from src.sync_catalog import (  # noqa: E402
    ActressCache,
    GenreCache,
    MovieLinkCache,
    SeriesCache,
    UpsertCounters,
    _process_items,
    _slugify,
)


def _make_item(
    cid: str,
    *,
    actress_id: int = 1069961,
    actress_name: str = "テスト 女優",
    series_id: int = 4279762,
    series_name: str = "AI Japan",
) -> dict:
    return {
        "content_id": cid,
        "product_id": cid,
        "title": f"作品 {cid}",
        "comment": "desc",
        "imageURL": {"list": "x", "large": "y"},
        "sampleMovieURL": {"size_720_480": "iframe"},
        "iteminfo": {
            "actress": [{"id": actress_id, "name": actress_name, "ruby": "てすと"}],
            "series": [{"id": series_id, "name": series_name}],
            "genre": [{"id": 1, "name": "ジャンルA"}],
        },
        "affiliateURL": "https://x.example",
        "date": "2026-05-01",
    }


async def _make_session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False, autoflush=True)
    return engine, Session


def _run(coro):
    return asyncio.run(coro)


def test_upsert_movie_basic_inserts_series_and_actress():
    """新規 upsert で series / actress が作成され、batch 内で再利用されること。"""

    async def go():
        engine, Session = await _make_session()
        async with Session() as session:
            gc = GenreCache()
            ac = ActressCache()
            sc = SeriesCache()
            lc = MovieLinkCache()
            await gc.warm(session)
            await ac.warm(session)
            await sc.warm(session)
            await session.commit()

            counters = UpsertCounters()
            items = [_make_item("test001"), _make_item("test002")]
            await _process_items(
                session, items, prefix="videoa", counters=counters,
                affiliate_id="af-990", floor="videoa", dry_run=False,
                actress_filter=None, http_client=None,
                genre_cache=gc, actress_cache=ac, series_cache=sc, link_cache=lc,
            )
            assert counters.inserted == 2
            assert counters.errors == 0
            # series / actress は batch 内で 1 回ずつだけ作られる
            actresses = (await session.execute(select(Actress))).scalars().all()
            series = (await session.execute(select(Series))).scalars().all()
            assert len(actresses) == 1
            assert len(series) == 1
        await engine.dispose()

    _run(go())


def test_upsert_recovers_from_duplicate_series_slug():
    """既存の Series に同じ slug が別 content_id で居る場合、UNIQUE 違反を
    catch して既存行を再利用すること (ジョブが止まらない)。"""

    async def go():
        engine, Session = await _make_session()
        async with Session() as session:
            # 既存 Series: slug は新 upsert が生成するものと同じ、content_id は異なる
            collision_slug = _slugify("AI Japan", "4279762")  # ai-japan-4279762
            pre = Series(
                id=str(uuid.uuid4()),
                content_id="OLD_DIFFERENT_ID",
                name="AI Japan (old)",
                slug=collision_slug,
            )
            session.add(pre)
            await session.commit()

            gc = GenreCache()
            ac = ActressCache()
            sc = SeriesCache()
            lc = MovieLinkCache()
            await gc.warm(session)
            await ac.warm(session)
            await sc.warm(session)
            await session.commit()

            counters = UpsertCounters()
            items = [_make_item("test001"), _make_item("test002")]
            await _process_items(
                session, items, prefix="videoa", counters=counters,
                affiliate_id="af-990", floor="videoa", dry_run=False,
                actress_filter=None, http_client=None,
                genre_cache=gc, actress_cache=ac, series_cache=sc, link_cache=lc,
            )
            assert counters.errors == 0, f"unexpected errors: {counters}"
            assert counters.inserted == 2
            # 既存 Series が再利用される
            series = (await session.execute(select(Series))).scalars().all()
            assert len(series) == 1
            assert series[0].slug == collision_slug
        await engine.dispose()

    _run(go())


def test_upsert_recovers_from_duplicate_actress_slug():
    """既存の Actress に同じ slug が居る (content_id が NULL のまま残骸として) 場合、
    UNIQUE 違反を catch して既存行を再利用し content_id を補完すること。"""

    async def go():
        engine, Session = await _make_session()
        async with Session() as session:
            pre = Actress(
                content_id=None,
                name="(旧) actress 名",
                slug="1069961",  # 新 upsert で生成される slug と衝突する
            )
            session.add(pre)
            await session.commit()

            gc = GenreCache()
            ac = ActressCache()
            sc = SeriesCache()
            lc = MovieLinkCache()
            await gc.warm(session)
            await ac.warm(session)
            await sc.warm(session)
            await session.commit()

            counters = UpsertCounters()
            await _process_items(
                session, [_make_item("test001")], prefix="videoa",
                counters=counters,
                affiliate_id="af-990", floor="videoa", dry_run=False,
                actress_filter=None, http_client=None,
                genre_cache=gc, actress_cache=ac, series_cache=sc, link_cache=lc,
            )
            assert counters.errors == 0
            actresses = (await session.execute(select(Actress))).scalars().all()
            assert len(actresses) == 1
            # 既存 Actress.content_id が補完されている
            assert actresses[0].content_id == "1069961"
        await engine.dispose()

    _run(go())


def test_upsert_recovers_from_duplicate_movie_content_id():
    """並行ジョブ等で同じ content_id の Movie が既に存在する場合、UNIQUE 違反を
    catch して update 扱いに切り替えること (ジョブが止まらない)。"""

    async def go():
        engine, Session = await _make_session()
        async with Session() as session:
            pre = Movie(
                id=str(uuid.uuid4()),
                content_id="test001",
                title="既存タイトル",
                slug="some-other-slug",
                affiliate_url="https://existing.example",
                is_visible=True,
            )
            session.add(pre)
            await session.commit()

            gc = GenreCache()
            ac = ActressCache()
            sc = SeriesCache()
            lc = MovieLinkCache()
            await gc.warm(session)
            await ac.warm(session)
            await sc.warm(session)
            await session.commit()

            counters = UpsertCounters()
            await _process_items(
                session, [_make_item("test001")], prefix="videoa",
                counters=counters,
                affiliate_id="af-990", floor="videoa", dry_run=False,
                actress_filter=None, http_client=None,
                genre_cache=gc, actress_cache=ac, series_cache=sc, link_cache=lc,
            )
            # 既存 Movie の content_id 引き当てで update パスに乗るのが正常パス。
            # 万一 SELECT が先に失敗しても、INSERT 後の UNIQUE 違反で recovered する。
            assert counters.errors == 0
            movies = (await session.execute(select(Movie))).scalars().all()
            assert len(movies) == 1
        await engine.dispose()

    _run(go())


def test_batch_continues_after_a_failing_item_doesnt_pollute_cache():
    """SAVEPOINT がロールバックしても、続く item の upsert が成功すること。
    既存 actress / series との slug 衝突を続けざまに起こしても問題なく動くこと。"""

    async def go():
        engine, Session = await _make_session()
        async with Session() as session:
            # 予め DB に slug 衝突の元になる actress / series を入れておく
            existing_actress = Actress(content_id=None, name="既存", slug="9999999")
            existing_series = Series(
                id=str(uuid.uuid4()),
                content_id="OLD",
                name="OldSeries",
                slug=_slugify("OldSeries", "8888888"),  # 新 upsert と衝突
            )
            session.add(existing_actress)
            session.add(existing_series)
            await session.commit()

            gc = GenreCache()
            ac = ActressCache()
            sc = SeriesCache()
            lc = MovieLinkCache()
            await gc.warm(session)
            await ac.warm(session)
            await sc.warm(session)
            await session.commit()

            # 日本語名 → ASCII で空 → slug は content_id (= "9999999") そのまま、
            # 既存 actress と slug 衝突する状態
            # series 名 "OldSeries" → "oldseries-8888888" は warm 済 SeriesCache.by_slug にヒット
            items = [
                _make_item(
                    "test001",
                    actress_id=9999999, actress_name="まったく日本語のみ",
                    series_id=8888888, series_name="OldSeries",
                ),
                _make_item(
                    "test002",
                    actress_id=9999999, actress_name="まったく日本語のみ",
                    series_id=8888888, series_name="OldSeries",
                ),
            ]

            counters = UpsertCounters()
            await _process_items(
                session, items, prefix="videoa", counters=counters,
                affiliate_id="af-990", floor="videoa", dry_run=False,
                actress_filter=None, http_client=None,
                genre_cache=gc, actress_cache=ac, series_cache=sc, link_cache=lc,
            )
            assert counters.errors == 0, f"got {counters}"
            assert counters.inserted == 2, f"got {counters}"
            # 既存の actress / series を再利用 — 新規行が増えていないこと
            actresses = (await session.execute(select(Actress))).scalars().all()
            series = (await session.execute(select(Series))).scalars().all()
            assert len(actresses) == 1
            assert len(series) == 1
        await engine.dispose()

    _run(go())


def test_actress_cache_get_or_create_handles_duplicate_slug():
    """ActressCache.get_or_create がキャッシュミス → INSERT で
    UNIQUE 違反 (slug 衝突) を起こしても、SELECT-fallback で既存を返すこと。"""

    async def go():
        engine, Session = await _make_session()
        async with Session() as session:
            pre = Actress(
                content_id=None,
                name="既存女優",
                slug="9876543",
            )
            session.add(pre)
            await session.commit()

            ac = ActressCache()
            # 意図的に warm() を呼ばず、キャッシュは空のまま get_or_create する。
            # → INSERT 試行 → IntegrityError → SELECT fallback で既存を返す。
            async with session.begin():
                async with session.begin_nested():
                    a = await ac.get_or_create(
                        session,
                        content_id="9876543",
                        name="DMM 表記の女優",
                        slug="9876543",
                    )
                    assert a.id == pre.id
                    # content_id が補完されている
                    assert a.content_id == "9876543"
        await engine.dispose()

    _run(go())
