"""sync_video_urls バッチのテスト。

- `_resolve_cli_args` の CLI / env / default 優先順位。
- リポジトリの対象抽出 (only_missing) + ジョブ本体の抽出 → DB 更新 (dry-run 含む)
  を in-memory SQLite で検証する。

JSONB は conftest.py で JSON に差し替え済み (SQLite テスト用)。
"""
from __future__ import annotations

import asyncio
import sys
import uuid
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[3] / "apps" / "api"))
sys.path.insert(0, str(_HERE.parents[1]))

from sqlalchemy import select  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

from app.db.base import Base  # noqa: E402
# Movie は Series / Genre / Actress へ relationship を張っているため、
# create_all / mapper 構成が確実に通るよう関連モデルも明示的に import する
# (test_no_eager_load.py と同じ方針)。app.db.models.__init__ 経由で読める場合でも
# import 順に依存せず単体で解決できるようにしておく。
from app.db.models.actress import Actress  # noqa: E402,F401
from app.db.models.genre import Genre  # noqa: E402,F401
from app.db.models.movie import Movie  # noqa: E402
from app.db.models.series import Series  # noqa: E402,F401
from app.repositories.movie_repository import (  # noqa: E402
    get_movie_video_url_targets,
)
from app.services import resolver_client  # noqa: E402
from src import sync_video_urls  # noqa: E402
from src.sync_catalog import _build_sessionmaker  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# CLI / env 優先順位
# ---------------------------------------------------------------------------
def _clear_env(monkeypatch):
    for k in (
        "SYNC_VIDEO_URLS_LIMIT",
        "SYNC_VIDEO_URLS_ONLY_MISSING",
        "SYNC_VIDEO_URLS_FORCE",
        "SYNC_VIDEO_URLS_DRY_RUN",
        "SYNC_VIDEO_URLS_CONCURRENCY",
    ):
        monkeypatch.delenv(k, raising=False)


def test_cli_defaults(monkeypatch):
    _clear_env(monkeypatch)
    cfg = sync_video_urls._resolve_cli_args([])
    assert cfg == dict(
        limit=None,
        only_missing=True,
        force=False,
        dry_run=False,
        concurrency=sync_video_urls.DEFAULT_CONCURRENCY,
    )


def test_cli_flags_override_env(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("SYNC_VIDEO_URLS_LIMIT", "10")
    monkeypatch.setenv("SYNC_VIDEO_URLS_CONCURRENCY", "8")
    cfg = sync_video_urls._resolve_cli_args(
        ["--limit", "5", "--force", "--dry-run", "--concurrency", "2"]
    )
    assert cfg["limit"] == 5
    assert cfg["force"] is True
    assert cfg["dry_run"] is True
    assert cfg["concurrency"] == 2


def test_env_fallback(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("SYNC_VIDEO_URLS_LIMIT", "7")
    monkeypatch.setenv("SYNC_VIDEO_URLS_ONLY_MISSING", "false")
    monkeypatch.setenv("SYNC_VIDEO_URLS_FORCE", "1")
    monkeypatch.setenv("SYNC_VIDEO_URLS_CONCURRENCY", "4")
    cfg = sync_video_urls._resolve_cli_args([])
    assert cfg["limit"] == 7
    assert cfg["only_missing"] is False
    assert cfg["force"] is True
    assert cfg["concurrency"] == 4


def test_no_only_missing_flag(monkeypatch):
    _clear_env(monkeypatch)
    cfg = sync_video_urls._resolve_cli_args(["--no-only-missing"])
    assert cfg["only_missing"] is False


def test_invalid_env_raises_systemexit(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("SYNC_VIDEO_URLS_LIMIT", "abc")
    with pytest.raises(SystemExit):
        sync_video_urls._resolve_cli_args([])


# ---------------------------------------------------------------------------
# 対象抽出 (only_missing) と 抽出 → DB 更新
# ---------------------------------------------------------------------------
async def _make_engine():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine


async def _seed(session) -> dict[str, str]:
    """3 作品を投入する。

    - m_missing : content_id あり / URL 未保存 → only_missing 対象
    - m_stored  : content_id あり / URL 保存済み → only_missing 非対象
    - m_no_cid  : content_id なし → 常に非対象
    Returns: name -> movie_id
    """
    ids: dict[str, str] = {}
    async with session.begin():
        m_missing = Movie(
            id=str(uuid.uuid4()), content_id="cid_missing", title="t1",
            slug="s1", review_count=10,
        )
        m_stored = Movie(
            id=str(uuid.uuid4()), content_id="cid_stored", title="t2",
            slug="s2", review_count=5,
            sample_mp4_url="https://cdn/x.mp4",
            sample_low_mp4_url="https://cdn/x_low.mp4",
            sample_high_mp4_url="https://cdn/x_high.mp4",
        )
        m_no_cid = Movie(
            id=str(uuid.uuid4()), content_id=None, title="t3", slug="s3",
        )
        for m in (m_missing, m_stored, m_no_cid):
            m.genres = []
            m.actresses = []
            session.add(m)
        ids = {
            "missing": m_missing.id,
            "stored": m_stored.id,
            "no_cid": m_no_cid.id,
        }
    return ids


def test_targets_only_missing_excludes_stored_and_no_cid():
    async def _go():
        engine = await _make_engine()
        Session = _build_sessionmaker(engine)
        async with Session() as session:
            ids = await _seed(session)
            targets = await get_movie_video_url_targets(session, only_missing=True)
            target_ids = {mid for mid, _cid in targets}
            assert ids["missing"] in target_ids
            assert ids["stored"] not in target_ids
            assert ids["no_cid"] not in target_ids
        await engine.dispose()

    _run(_go())


def test_targets_all_excludes_only_no_cid():
    async def _go():
        engine = await _make_engine()
        Session = _build_sessionmaker(engine)
        async with Session() as session:
            ids = await _seed(session)
            targets = await get_movie_video_url_targets(session, only_missing=False)
            target_ids = {mid for mid, _cid in targets}
            assert ids["missing"] in target_ids
            assert ids["stored"] in target_ids
            assert ids["no_cid"] not in target_ids
        await engine.dispose()

    _run(_go())


def test_process_chunk_persists_resolved(monkeypatch):
    async def _go():
        engine = await _make_engine()
        Session = _build_sessionmaker(engine)
        async with Session() as session:
            ids = await _seed(session)

            async def _fake_resolve(content_id, *, bypass_cache=False, **kwargs):  # noqa: ARG001
                return resolver_client.ResolvedMp4(
                    mp4_url=f"https://new/{content_id}.mp4",
                    low_mp4_url=f"https://new/{content_id}_low.mp4",
                    high_mp4_url=f"https://new/{content_id}_high.mp4",
                )

            monkeypatch.setattr(resolver_client, "resolve_mp4", _fake_resolve)

            counters = sync_video_urls.Counters()
            chunk = [(ids["missing"], "cid_missing")]
            await sync_video_urls._process_chunk(
                session,
                chunk,
                semaphore=asyncio.Semaphore(2),
                force=False,
                dry_run=False,
                counters=counters,
            )
            assert counters.saved == 1
            row = (
                await session.execute(
                    select(
                        Movie.sample_mp4_url,
                        Movie.sample_low_mp4_url,
                        Movie.sample_high_mp4_url,
                        Movie.sample_mp4_resolved_at,
                    ).where(Movie.id == ids["missing"])
                )
            ).first()
            assert row[0] == "https://new/cid_missing.mp4"
            assert row[1] == "https://new/cid_missing_low.mp4"
            assert row[2] == "https://new/cid_missing_high.mp4"
            assert row[3] is not None
        await engine.dispose()

    _run(_go())


def test_process_chunk_dry_run_does_not_write(monkeypatch):
    async def _go():
        engine = await _make_engine()
        Session = _build_sessionmaker(engine)
        async with Session() as session:
            ids = await _seed(session)

            async def _fake_resolve(content_id, *, bypass_cache=False, **kwargs):  # noqa: ARG001
                return resolver_client.ResolvedMp4(
                    mp4_url=f"https://new/{content_id}.mp4",
                    low_mp4_url=None,
                    high_mp4_url=None,
                )

            monkeypatch.setattr(resolver_client, "resolve_mp4", _fake_resolve)

            counters = sync_video_urls.Counters()
            chunk = [(ids["missing"], "cid_missing")]
            await sync_video_urls._process_chunk(
                session,
                chunk,
                semaphore=asyncio.Semaphore(2),
                force=False,
                dry_run=True,
                counters=counters,
            )
            assert counters.saved == 0
            assert counters.skipped == 1
            row = (
                await session.execute(
                    select(Movie.sample_mp4_url).where(Movie.id == ids["missing"])
                )
            ).first()
            # dry-run では書き込まれない
            assert row[0] is None
        await engine.dispose()

    _run(_go())
