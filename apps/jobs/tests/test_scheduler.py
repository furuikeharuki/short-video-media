"""scheduler.py の SCHEDULE_* 環境変数を介した挙動テスト。

ジョブ本体 (sync_catalog / resolve_sample_urls / sync_actress_profiles) は
APScheduler 経由でしか起動されない。本テストでは:

  - 未設定時の後方互換 (デフォルト引数で呼ばれる)
  - SCHEDULE_* 設定時の反映
  - SCHEDULE_ENABLE_* = false でジョブ登録自体がスキップされる

を確認する。実 DB / 外部 API には依存しない (job main を patch する)。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from apscheduler.schedulers.asyncio import AsyncIOScheduler

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[1]))

from src import scheduler as sched  # noqa: E402


# ----------------------------------------------------------------------
# helper: env 環境変数を一時的に書き換える
# ----------------------------------------------------------------------


@pytest.fixture
def clean_env(monkeypatch):
    """SCHEDULE_* / RESOLVE_CONCURRENCY 系を一度全部消す。"""
    for key in list(__import__("os").environ.keys()):
        if key.startswith("SCHEDULE_") or key == "RESOLVE_CONCURRENCY":
            monkeypatch.delenv(key, raising=False)
    return monkeypatch


# ----------------------------------------------------------------------
# _env_* ユーティリティ
# ----------------------------------------------------------------------


def test_env_bool_default(clean_env):
    assert sched._env_bool("MISSING", True) is True
    assert sched._env_bool("MISSING", False) is False


def test_env_bool_truthy(clean_env):
    clean_env.setenv("X", "true")
    assert sched._env_bool("X", False) is True
    clean_env.setenv("X", "FALSE")
    assert sched._env_bool("X", True) is False
    clean_env.setenv("X", "1")
    assert sched._env_bool("X", False) is True
    clean_env.setenv("X", "0")
    assert sched._env_bool("X", True) is False
    clean_env.setenv("X", "")
    # 空文字は default
    assert sched._env_bool("X", True) is True


def test_env_int(clean_env):
    assert sched._env_int("MISSING", None) is None
    assert sched._env_int("MISSING", 5) == 5
    clean_env.setenv("X", "42")
    assert sched._env_int("X", 0) == 42
    clean_env.setenv("X", "bogus")
    # 不正値は default
    assert sched._env_int("X", 7) == 7


def test_env_floors_unset(clean_env):
    assert sched._env_floors("SCHEDULE_SYNC_CATALOG_FLOORS") is None


def test_env_floors_parsed(clean_env):
    clean_env.setenv("SCHEDULE_SYNC_CATALOG_FLOORS", "videoa, videoc , ")
    assert sched._env_floors("SCHEDULE_SYNC_CATALOG_FLOORS") == ["videoa", "videoc"]


def test_env_floors_empty_string_is_none(clean_env):
    clean_env.setenv("SCHEDULE_SYNC_CATALOG_FLOORS", "   ,  , ")
    # 空要素のみは None 扱い (= sync_catalog のデフォルト挙動)
    assert sched._env_floors("SCHEDULE_SYNC_CATALOG_FLOORS") is None


# ----------------------------------------------------------------------
# _run_sync_catalog: 既定 / 環境変数上書きの両方で sync_main に渡る引数
# ----------------------------------------------------------------------


def test_run_sync_catalog_defaults(clean_env):
    mock_main = AsyncMock(return_value=None)
    with patch.object(sched, "sync_main", mock_main):
        asyncio.run(sched._run_sync_catalog())
    mock_main.assert_awaited_once()
    kwargs = mock_main.await_args.kwargs
    assert kwargs["mode"] == "incremental"
    assert kwargs["hits_per_floor"] == 100
    assert kwargs["floors_filter"] is None
    assert kwargs["dry_run"] is False
    assert kwargs["start_date"] is None
    assert kwargs["end_date"] is None


def test_run_sync_catalog_env_override(clean_env):
    clean_env.setenv("SCHEDULE_SYNC_CATALOG_MODE", "full")
    clean_env.setenv("SCHEDULE_SYNC_CATALOG_HITS_PER_FLOOR", "50")
    clean_env.setenv("SCHEDULE_SYNC_CATALOG_FLOORS", "videoa,videoc")
    mock_main = AsyncMock(return_value=None)
    with patch.object(sched, "sync_main", mock_main):
        asyncio.run(sched._run_sync_catalog())
    kwargs = mock_main.await_args.kwargs
    assert kwargs["mode"] == "full"
    assert kwargs["hits_per_floor"] == 50
    assert kwargs["floors_filter"] == ["videoa", "videoc"]


def test_run_sync_catalog_swallows_exception(clean_env):
    """ジョブ内例外はスケジューラに伝播させない。"""
    mock_main = AsyncMock(side_effect=RuntimeError("boom"))
    with patch.object(sched, "sync_main", mock_main):
        # 例外を投げないこと
        asyncio.run(sched._run_sync_catalog())


# ----------------------------------------------------------------------
# _run_resolve_sample_urls
# ----------------------------------------------------------------------


def test_run_resolve_sample_urls_defaults(clean_env):
    mock_main = AsyncMock(return_value=None)
    with patch.object(sched, "resolve_main", mock_main):
        asyncio.run(sched._run_resolve_sample_urls())
    kwargs = mock_main.await_args.kwargs
    assert kwargs["concurrency"] == 4  # RESOLVE_CONCURRENCY デフォルト
    assert kwargs["limit"] is None
    assert kwargs["dry_run"] is False
    assert kwargs["force_all"] is False


def test_run_resolve_sample_urls_env_override(clean_env):
    clean_env.setenv("RESOLVE_CONCURRENCY", "4")
    clean_env.setenv("SCHEDULE_RESOLVE_LIMIT", "1000")
    mock_main = AsyncMock(return_value=None)
    with patch.object(sched, "resolve_main", mock_main):
        asyncio.run(sched._run_resolve_sample_urls())
    kwargs = mock_main.await_args.kwargs
    assert kwargs["concurrency"] == 4
    assert kwargs["limit"] == 1000
    assert kwargs["force_all"] is False


# ----------------------------------------------------------------------
# _run_resolve_sample_urls_full_refresh: 月次フルリフレッシュ
# ----------------------------------------------------------------------


def test_run_resolve_sample_urls_full_refresh_defaults(clean_env):
    mock_main = AsyncMock(return_value=None)
    with patch.object(sched, "resolve_main", mock_main):
        asyncio.run(sched._run_resolve_sample_urls_full_refresh())
    kwargs = mock_main.await_args.kwargs
    assert kwargs["concurrency"] == 4
    assert kwargs["limit"] is None
    assert kwargs["dry_run"] is False
    assert kwargs["force_all"] is True


def test_run_resolve_sample_urls_full_refresh_limit_env_override(clean_env):
    clean_env.setenv("SCHEDULE_RESOLVE_FULL_REFRESH_LIMIT", "5000")
    clean_env.setenv("RESOLVE_CONCURRENCY", "2")
    mock_main = AsyncMock(return_value=None)
    with patch.object(sched, "resolve_main", mock_main):
        asyncio.run(sched._run_resolve_sample_urls_full_refresh())
    kwargs = mock_main.await_args.kwargs
    assert kwargs["concurrency"] == 2
    assert kwargs["limit"] == 5000
    assert kwargs["force_all"] is True


def test_run_resolve_sample_urls_full_refresh_swallows_exception(clean_env):
    mock_main = AsyncMock(side_effect=RuntimeError("boom"))
    with patch.object(sched, "resolve_main", mock_main):
        asyncio.run(sched._run_resolve_sample_urls_full_refresh())


def test_run_resolve_sample_urls_full_refresh_independent_limit(clean_env):
    """通常 resolve の SCHEDULE_RESOLVE_LIMIT はフルリフレッシュに影響しない。"""
    clean_env.setenv("SCHEDULE_RESOLVE_LIMIT", "100")
    mock_main = AsyncMock(return_value=None)
    with patch.object(sched, "resolve_main", mock_main):
        asyncio.run(sched._run_resolve_sample_urls_full_refresh())
    kwargs = mock_main.await_args.kwargs
    assert kwargs["limit"] is None
    assert kwargs["force_all"] is True


# ----------------------------------------------------------------------
# _run_sync_actress_profiles
# ----------------------------------------------------------------------


def test_run_sync_actress_profiles_defaults(clean_env):
    mock_main = AsyncMock(return_value=None)
    with patch.object(sched, "actress_main", mock_main):
        asyncio.run(sched._run_sync_actress_profiles())
    kwargs = mock_main.await_args.kwargs
    assert kwargs["only_missing"] is True
    assert kwargs["limit"] is None
    assert kwargs["dry_run"] is False


def test_run_sync_actress_profiles_env_override(clean_env):
    clean_env.setenv("SCHEDULE_ACTRESS_ONLY_MISSING", "false")
    clean_env.setenv("SCHEDULE_ACTRESS_LIMIT", "200")
    mock_main = AsyncMock(return_value=None)
    with patch.object(sched, "actress_main", mock_main):
        asyncio.run(sched._run_sync_actress_profiles())
    kwargs = mock_main.await_args.kwargs
    assert kwargs["only_missing"] is False
    assert kwargs["limit"] == 200


# ----------------------------------------------------------------------
# _register_jobs: enable フラグと cron 上書き
# ----------------------------------------------------------------------


def test_register_jobs_default_registers_all(clean_env):
    """デフォルトでは月次フルリフレッシュを除く 3 ジョブが登録される。"""
    scheduler = AsyncIOScheduler(timezone=sched.TZ)
    sched._register_jobs(scheduler)
    job_ids = {j.id for j in scheduler.get_jobs()}
    assert job_ids == {"sync_catalog", "resolve_sample_urls", "sync_actress_profiles"}
    # フルリフレッシュはデフォルト OFF
    assert "resolve_sample_urls_full_refresh" not in job_ids


def test_register_jobs_enable_full_refresh(clean_env):
    """SCHEDULE_ENABLE_RESOLVE_SAMPLE_URLS_FULL_REFRESH=true で 4 ジョブ目が増える。"""
    clean_env.setenv("SCHEDULE_ENABLE_RESOLVE_SAMPLE_URLS_FULL_REFRESH", "true")
    scheduler = AsyncIOScheduler(timezone=sched.TZ)
    sched._register_jobs(scheduler)
    job_ids = {j.id for j in scheduler.get_jobs()}
    assert "resolve_sample_urls_full_refresh" in job_ids
    # 既存ジョブは引き続き登録されている
    assert "resolve_sample_urls" in job_ids


def test_register_jobs_full_refresh_default_cron(clean_env):
    """フルリフレッシュのデフォルト cron は day=1, hour=3, minute=0 (毎月 1 日 03:00 JST)。"""
    clean_env.setenv("SCHEDULE_ENABLE_RESOLVE_SAMPLE_URLS_FULL_REFRESH", "true")
    scheduler = AsyncIOScheduler(timezone=sched.TZ)
    sched._register_jobs(scheduler)
    jobs = {j.id: j for j in scheduler.get_jobs()}
    fields = {f.name: str(f) for f in jobs["resolve_sample_urls_full_refresh"].trigger.fields}
    assert fields["day"] == "1"
    assert fields["hour"] == "3"
    assert fields["minute"] == "0"


def test_register_jobs_full_refresh_cron_override(clean_env):
    clean_env.setenv("SCHEDULE_ENABLE_RESOLVE_SAMPLE_URLS_FULL_REFRESH", "true")
    clean_env.setenv("SCHEDULE_RESOLVE_FULL_REFRESH_CRON_DAY", "15")
    clean_env.setenv("SCHEDULE_RESOLVE_FULL_REFRESH_CRON_HOUR", "4")
    clean_env.setenv("SCHEDULE_RESOLVE_FULL_REFRESH_CRON_MINUTE", "30")
    scheduler = AsyncIOScheduler(timezone=sched.TZ)
    sched._register_jobs(scheduler)
    jobs = {j.id: j for j in scheduler.get_jobs()}
    fields = {f.name: str(f) for f in jobs["resolve_sample_urls_full_refresh"].trigger.fields}
    assert fields["day"] == "15"
    assert fields["hour"] == "4"
    assert fields["minute"] == "30"


def test_register_jobs_disable_sync_catalog(clean_env):
    clean_env.setenv("SCHEDULE_ENABLE_SYNC_CATALOG", "false")
    scheduler = AsyncIOScheduler(timezone=sched.TZ)
    sched._register_jobs(scheduler)
    job_ids = {j.id for j in scheduler.get_jobs()}
    assert "sync_catalog" not in job_ids
    assert "resolve_sample_urls" in job_ids
    assert "sync_actress_profiles" in job_ids


def test_register_jobs_disable_resolve(clean_env):
    clean_env.setenv("SCHEDULE_ENABLE_RESOLVE_SAMPLE_URLS", "false")
    scheduler = AsyncIOScheduler(timezone=sched.TZ)
    sched._register_jobs(scheduler)
    job_ids = {j.id for j in scheduler.get_jobs()}
    assert "resolve_sample_urls" not in job_ids


def test_register_jobs_disable_actress(clean_env):
    clean_env.setenv("SCHEDULE_ENABLE_ACTRESS_PROFILES", "false")
    scheduler = AsyncIOScheduler(timezone=sched.TZ)
    sched._register_jobs(scheduler)
    job_ids = {j.id for j in scheduler.get_jobs()}
    assert "sync_actress_profiles" not in job_ids


def test_register_jobs_disable_all(clean_env):
    clean_env.setenv("SCHEDULE_ENABLE_SYNC_CATALOG", "false")
    clean_env.setenv("SCHEDULE_ENABLE_RESOLVE_SAMPLE_URLS", "false")
    clean_env.setenv("SCHEDULE_ENABLE_ACTRESS_PROFILES", "false")
    scheduler = AsyncIOScheduler(timezone=sched.TZ)
    sched._register_jobs(scheduler)
    assert scheduler.get_jobs() == []


def test_register_jobs_cron_override(clean_env):
    clean_env.setenv("SCHEDULE_SYNC_CATALOG_CRON_HOUR", "9")
    clean_env.setenv("SCHEDULE_SYNC_CATALOG_CRON_MINUTE", "30")
    clean_env.setenv("SCHEDULE_RESOLVE_CRON_HOUR", "14")
    clean_env.setenv("SCHEDULE_ACTRESS_CRON_HOUR", "15")
    scheduler = AsyncIOScheduler(timezone=sched.TZ)
    sched._register_jobs(scheduler)
    jobs = {j.id: j for j in scheduler.get_jobs()}
    # CronTrigger の fields は順序が決まっており、hour / minute が含まれる。
    sync_trigger = jobs["sync_catalog"].trigger
    sync_fields = {f.name: str(f) for f in sync_trigger.fields}
    assert sync_fields["hour"] == "9"
    assert sync_fields["minute"] == "30"
    resolve_fields = {f.name: str(f) for f in jobs["resolve_sample_urls"].trigger.fields}
    assert resolve_fields["hour"] == "14"
    actress_fields = {f.name: str(f) for f in jobs["sync_actress_profiles"].trigger.fields}
    assert actress_fields["hour"] == "15"
