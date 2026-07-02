"""関連オブジェクトの eager-load 抑止 (OOM = exit 137 対策) の回帰テスト。

共有モデル (apps/api) はフィード API 用に
  Genre.movies / Actress.movies / Actress.goods / Series.movies /
  Movie.genres / Movie.actresses
を lazy="selectin" (Movie.series は joined) で定義している。

このバッチで `select(Genre)` / `select(Actress)` / `select(Series)` / `select(Movie)`
をそのまま投げると selectin が芋づる式に関連を全件ロードし、本番規模では
プロセスメモリが VPS 上限を超えて SIGKILL(137) になる。

ここでは:
  1. `_build_sessionmaker()` 製の session ではエンティティ SELECT が
     追加の relationship SELECT を一切発火しないこと (1 文で完結)。
  2. 列だけの SELECT (`select(Actress.name)`) は従来どおり動くこと。
  3. 各 Cache.warm() が plain session 上でも関連をロードしないこと。
"""
from __future__ import annotations

import asyncio
import sys
import uuid
from pathlib import Path

# JSONB は conftest.py で JSON に差し替え済み (SQLite テスト用)。

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[3] / "apps" / "api"))
sys.path.insert(0, str(_HERE.parents[1]))

from sqlalchemy import event, select  # noqa: E402
from sqlalchemy.ext.asyncio import (  # noqa: E402
    async_sessionmaker,
    create_async_engine,
)

from app.db.base import Base  # noqa: E402
from app.db.models.actress import Actress  # noqa: E402
from app.db.models.genre import Genre  # noqa: E402
from app.db.models.movie import Movie  # noqa: E402
from app.db.models.series import Series  # noqa: E402
from src.sync_catalog import (  # noqa: E402
    ActressCache,
    GenreCache,
    SeriesCache,
    _build_sessionmaker,
)


def _run(coro):
    return asyncio.run(coro)


async def _make_engine():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine


def _track_selects(engine, seen: list[str]):
    """engine の SELECT 文を `seen` に記録するリスナを張り、リスナ関数を返す。

    呼び出し側は `event.remove(engine.sync_engine, "before_cursor_execute", fn)`
    で確実に解除できる。
    """

    def _rec(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
        if statement.lstrip().upper().startswith("SELECT"):
            seen.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", _rec)
    return _rec


async def _seed(session) -> None:
    """プロ女優ジャンル + 女優 + シリーズ + それらを共有する作品を投入する。

    「プロ女優」ジャンルは全作品にぶら下がるため、1 行のジャンルを引くだけで
    全作品 → 全女優 → 全 goods へと selectin がカスケードしうる構造を再現する。
    """
    async with session.begin():
        pro = Genre(name="プロ女優")
        pro.movies = []
        genres = [Genre(name=f"genre{i}") for i in range(3)]
        actresses = [
            Actress(content_id=f"a{i}", name=f"name{i}", slug=f"slug{i}")
            for i in range(3)
        ]
        series = [
            Series(
                id=str(uuid.uuid4()),
                content_id=f"sc{i}",
                name=f"series{i}",
                slug=f"se{i}",
            )
            for i in range(3)
        ]
        for obj in [pro, *genres, *actresses, *series]:
            if hasattr(obj, "movies"):
                obj.movies = []
            if hasattr(obj, "goods"):
                obj.goods = []
        session.add_all([pro, *genres, *actresses, *series])
        await session.flush()
        for m in range(15):
            movie = Movie(
                id=str(uuid.uuid4()),
                content_id=f"c{m}",
                title="t",
                slug=f"mslug{m}",
            )
            movie.genres = [pro, *genres]
            movie.actresses = list(actresses)
            movie.series_id = series[m % 3].id
            session.add(movie)
        await session.flush()


def test_build_sessionmaker_suppresses_relationship_cascade():
    """`_build_sessionmaker()` 製 session では entity SELECT が
    relationship の追加 SELECT を発火しない (1 文で完結する)。"""

    async def go():
        engine = await _make_engine()
        Session = _build_sessionmaker(engine)
        async with Session() as session:
            await _seed(session)

            for entity in (Genre, Actress, Series, Movie):
                seen: list[str] = []
                listener = _track_selects(engine, seen)
                try:
                    async with session.begin():
                        rows = (
                            await session.execute(select(entity))
                        ).scalars().all()
                        # 列アクセスしてもカスケードしないこと
                        _ = [r.id for r in rows]
                finally:
                    event.remove(
                        engine.sync_engine, "before_cursor_execute", listener
                    )
                assert rows, f"{entity.__name__} rows should not be empty"
                assert len(seen) == 1, (
                    f"select({entity.__name__}) must emit exactly 1 SELECT "
                    f"(no selectin cascade); got {len(seen)}:\n"
                    + "\n".join(s.splitlines()[0] for s in seen)
                )
        await engine.dispose()

    _run(go())


def test_column_only_select_still_works_under_guard():
    """guard 下でも列だけの SELECT (`select(Actress.name)`) は普通に動く。"""

    async def go():
        engine = await _make_engine()
        Session = _build_sessionmaker(engine)
        async with Session() as session:
            await _seed(session)
            async with session.begin():
                names = (
                    await session.execute(select(Actress.name).order_by(Actress.name))
                ).scalars().all()
            assert names == ["name0", "name1", "name2"]
        await engine.dispose()

    _run(go())


def test_cache_warm_does_not_cascade_on_plain_session():
    """各 Cache.warm() は素の (guard 無し) session 上でも
    relationship をロードしない (warm() 自体が noload を付ける)。"""

    async def go():
        engine = await _make_engine()
        # あえて guard 無しの素の sessionmaker を使う
        Session = async_sessionmaker(engine, expire_on_commit=False)
        async with Session() as session:
            await _seed(session)

            for cache_factory, label in (
                (GenreCache, "GenreCache"),
                (ActressCache, "ActressCache"),
                (SeriesCache, "SeriesCache"),
            ):
                cache = cache_factory()
                seen: list[str] = []
                listener = _track_selects(engine, seen)
                try:
                    async with session.begin():
                        await cache.warm(session)
                finally:
                    event.remove(
                        engine.sync_engine, "before_cursor_execute", listener
                    )
                assert len(seen) == 1, (
                    f"{label}.warm() must emit exactly 1 SELECT (no cascade); "
                    f"got {len(seen)}:\n"
                    + "\n".join(s.splitlines()[0] for s in seen)
                )
        await engine.dispose()

    _run(go())
