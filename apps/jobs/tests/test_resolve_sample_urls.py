"""resolve_sample_urls の力学的テスト。

main() 内の対象抽出 SQL が --force-all (force_all=True) のとき
`sample_movie_url IS NULL` フィルタを外して全件を対象にすることを、
SQLAlchemy Engine / Session をモックして検証する。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[1]))

# 必須環境変数を埋めてからインポート (import 時に side effect は無いが念のため)
import os

os.environ.setdefault("DATABASE_URL", "postgresql://u:p@h/db")
os.environ.setdefault("DMM_AFFILIATE_ID", "test-affi-001")

from src import resolve_sample_urls as rsu  # noqa: E402


class _FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _FakeSession:
    """async with でも単体 await でも使える session モック。"""

    last_stmt = None

    def __init__(self, rows):
        self._rows = rows

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def execute(self, stmt):
        _FakeSession.last_stmt = stmt
        return _FakeResult(self._rows)

    async def commit(self):
        pass


def _run(force_all: bool):
    rows = []  # 空にして extractor 呼び出しが走らないようにする
    fake_session_cls = lambda: _FakeSession(rows)  # noqa: E731

    fake_engine = MagicMock()
    fake_engine.dispose = AsyncMock(return_value=None)

    with patch.object(rsu, "create_async_engine", return_value=fake_engine), \
         patch.object(rsu, "async_sessionmaker", return_value=fake_session_cls):
        asyncio.run(
            rsu.main(
                concurrency=1,
                limit=None,
                dry_run=True,
                force_all=force_all,
            )
        )
    return _FakeSession.last_stmt


def test_main_default_filters_null_sample_movie_url():
    stmt = _run(force_all=False)
    assert stmt is not None
    sql = str(stmt.compile(compile_kwargs={"literal_binds": True}))
    # 通常モードでは sample_movie_url IS NULL フィルタが入る
    assert "sample_movie_url IS NULL" in sql


def test_main_force_all_skips_null_filter():
    stmt = _run(force_all=True)
    assert stmt is not None
    sql = str(stmt.compile(compile_kwargs={"literal_binds": True}))
    # force_all=True では sample_movie_url IS NULL フィルタが入らない
    assert "sample_movie_url IS NULL" not in sql
    # content_id IS NOT NULL は引き続き入る
    assert "content_id IS NOT NULL" in sql
