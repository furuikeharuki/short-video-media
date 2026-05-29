"""定期実行で取得対象を切り替えるための env var パースをテストする。

- `scheduled_config` の helper 単体テスト
- `sync_catalog._resolve_cli_args` / `sync_actress_profiles._resolve_cli_args`
  の CLI / env / default 優先順位
- 不正値で SystemExit すること
"""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import pytest

# apps/jobs/src を import パスに追加
_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[1]))

from src import scheduled_config as cfg  # noqa: E402
from src.sync_actress_profiles import (  # noqa: E402
    _resolve_cli_args as _resolve_actress_args,
)
from src.sync_catalog import (  # noqa: E402
    _resolve_cli_args as _resolve_catalog_args,
)


# ---------------------------------------------------------------------------
# scheduled_config helpers
# ---------------------------------------------------------------------------

def test_env_int_parses(monkeypatch):
    monkeypatch.setenv("X_INT", "42")
    assert cfg.env_int("X_INT") == 42


def test_env_int_unset_returns_none(monkeypatch):
    monkeypatch.delenv("X_INT", raising=False)
    assert cfg.env_int("X_INT") is None


def test_env_int_empty_returns_none(monkeypatch):
    monkeypatch.setenv("X_INT", "  ")
    assert cfg.env_int("X_INT") is None


def test_env_int_invalid_raises(monkeypatch):
    monkeypatch.setenv("X_INT", "abc")
    with pytest.raises(cfg.EnvConfigError):
        cfg.env_int("X_INT")


def test_env_int_below_minimum_raises(monkeypatch):
    monkeypatch.setenv("X_INT", "0")
    with pytest.raises(cfg.EnvConfigError):
        cfg.env_int("X_INT", minimum=1)


def test_env_bool_truthy(monkeypatch):
    for v in ("1", "true", "TRUE", "yes", "On"):
        monkeypatch.setenv("X_BOOL", v)
        assert cfg.env_bool("X_BOOL") is True


def test_env_bool_falsy(monkeypatch):
    for v in ("0", "false", "no", "off"):
        monkeypatch.setenv("X_BOOL", v)
        assert cfg.env_bool("X_BOOL") is False


def test_env_bool_default(monkeypatch):
    monkeypatch.delenv("X_BOOL", raising=False)
    assert cfg.env_bool("X_BOOL", default=False) is False
    assert cfg.env_bool("X_BOOL", default=True) is True


def test_env_bool_invalid_raises(monkeypatch):
    monkeypatch.setenv("X_BOOL", "maybe")
    with pytest.raises(cfg.EnvConfigError):
        cfg.env_bool("X_BOOL")


def test_env_date_iso_valid(monkeypatch):
    monkeypatch.setenv("X_DATE", "2026-05-29")
    assert cfg.env_date_iso("X_DATE") == "2026-05-29"


def test_env_date_iso_invalid_raises(monkeypatch):
    monkeypatch.setenv("X_DATE", "2026/05/29")
    with pytest.raises(cfg.EnvConfigError):
        cfg.env_date_iso("X_DATE")


def test_env_floor_list_basic(monkeypatch):
    monkeypatch.setenv("X_FLOORS", "videoa, videoc , goods")
    assert cfg.env_floor_list("X_FLOORS") == ["videoa", "videoc", "goods"]


def test_env_floor_list_dedup_and_strip(monkeypatch):
    monkeypatch.setenv("X_FLOORS", "videoa,videoa, , videoc")
    assert cfg.env_floor_list("X_FLOORS") == ["videoa", "videoc"]


def test_env_floor_list_unset_returns_none(monkeypatch):
    monkeypatch.delenv("X_FLOORS", raising=False)
    assert cfg.env_floor_list("X_FLOORS") is None


def test_env_floor_list_invalid_raises(monkeypatch):
    monkeypatch.setenv("X_FLOORS", "videoa,bogus")
    with pytest.raises(cfg.EnvConfigError):
        cfg.env_floor_list("X_FLOORS")


def test_env_choice(monkeypatch):
    monkeypatch.setenv("X_MODE", "full")
    assert cfg.env_choice("X_MODE", ["incremental", "full"]) == "full"
    monkeypatch.setenv("X_MODE", "lol")
    with pytest.raises(cfg.EnvConfigError):
        cfg.env_choice("X_MODE", ["incremental", "full"])


# ---------------------------------------------------------------------------
# sync_catalog CLI / env resolution
# ---------------------------------------------------------------------------

# cron で最新を取り続ける運用にロックするため、cron 用 env として受け付けるのは
# 「相対値 (HITS / FLOORS / LOOKBACK_DAYS / DRY_RUN)」だけ。
# 固定日付 env (GTE_DATE / LTE_DATE / START_DATE / END_DATE) と MODE は意図的に
# 無視される — テストで明示的に固定する。
_CATALOG_ENV_KEYS = (
    "SYNC_CATALOG_HITS",
    "SYNC_CATALOG_FLOORS",
    "SYNC_CATALOG_LOOKBACK_DAYS",
    "SYNC_CATALOG_DRY_RUN",
    # 以下は cron 設定面では「受け付けないこと」自体をテストする対象
    "SYNC_CATALOG_MODE",
    "SYNC_CATALOG_GTE_DATE",
    "SYNC_CATALOG_LTE_DATE",
    "SYNC_CATALOG_START_DATE",
    "SYNC_CATALOG_END_DATE",
)


def _clean_catalog_env(monkeypatch):
    for k in _CATALOG_ENV_KEYS:
        monkeypatch.delenv(k, raising=False)


def test_catalog_defaults_when_nothing_set(monkeypatch):
    _clean_catalog_env(monkeypatch)
    kwargs = _resolve_catalog_args([])
    assert kwargs["mode"] == "incremental"
    assert kwargs["hits_per_floor"] == 100
    assert kwargs["floors_filter"] is None  # sync_catalog の mode 別 default に委譲
    assert kwargs["dry_run"] is False
    assert kwargs["incremental_gte"] is None
    assert kwargs["incremental_lte"] is None
    assert kwargs["start_date"] is None
    assert kwargs["end_date"] is None


def test_catalog_env_overrides_defaults(monkeypatch):
    _clean_catalog_env(monkeypatch)
    monkeypatch.setenv("SYNC_CATALOG_HITS", "50")
    monkeypatch.setenv("SYNC_CATALOG_FLOORS", "videoa,goods")
    monkeypatch.setenv("SYNC_CATALOG_DRY_RUN", "true")
    kwargs = _resolve_catalog_args([])
    assert kwargs["hits_per_floor"] == 50
    assert kwargs["floors_filter"] == ["videoa", "goods"]
    assert kwargs["dry_run"] is True


def test_catalog_cli_overrides_env(monkeypatch):
    _clean_catalog_env(monkeypatch)
    monkeypatch.setenv("SYNC_CATALOG_HITS", "50")
    monkeypatch.setenv("SYNC_CATALOG_FLOORS", "goods")
    kwargs = _resolve_catalog_args(["--hits", "10", "--floors", "videoa"])
    assert kwargs["hits_per_floor"] == 10
    assert kwargs["floors_filter"] == ["videoa"]


def test_catalog_lookback_days_computes_relative_gte(monkeypatch):
    """SYNC_CATALOG_LOOKBACK_DAYS=N で gte_date が (今日 - N 日) になること。
    固定値ではないため、cron が走るたびに新しい日付が計算される。"""
    from datetime import date as _date
    _clean_catalog_env(monkeypatch)
    monkeypatch.setenv("SYNC_CATALOG_LOOKBACK_DAYS", "7")
    kwargs = _resolve_catalog_args([])
    expected = (_date.today() - __import__("datetime").timedelta(days=7)).isoformat()
    assert kwargs["incremental_gte"] == f"{expected}T00:00:00"
    # lte_date は cron では入れない (常に最新まで取りに行く)
    assert kwargs["incremental_lte"] is None


def test_catalog_cli_gte_date_overrides_lookback(monkeypatch):
    """CLI で --gte-date を渡したら env LOOKBACK_DAYS より優先される。"""
    _clean_catalog_env(monkeypatch)
    monkeypatch.setenv("SYNC_CATALOG_LOOKBACK_DAYS", "7")
    kwargs = _resolve_catalog_args(["--gte-date", "2024-01-01"])
    assert kwargs["incremental_gte"] == "2024-01-01T00:00:00"


def test_catalog_invalid_env_floor_exits(monkeypatch):
    _clean_catalog_env(monkeypatch)
    monkeypatch.setenv("SYNC_CATALOG_FLOORS", "videoa,bogus")
    with pytest.raises(SystemExit) as exc:
        _resolve_catalog_args([])
    assert "未知の floor" in str(exc.value)


def test_catalog_invalid_env_hits_exits(monkeypatch):
    _clean_catalog_env(monkeypatch)
    monkeypatch.setenv("SYNC_CATALOG_HITS", "not-a-number")
    with pytest.raises(SystemExit):
        _resolve_catalog_args([])


def test_catalog_invalid_env_lookback_days_exits(monkeypatch):
    _clean_catalog_env(monkeypatch)
    monkeypatch.setenv("SYNC_CATALOG_LOOKBACK_DAYS", "0")
    with pytest.raises(SystemExit):
        _resolve_catalog_args([])
    monkeypatch.setenv("SYNC_CATALOG_LOOKBACK_DAYS", "not-int")
    with pytest.raises(SystemExit):
        _resolve_catalog_args([])


def test_catalog_dry_run_cli_flag_wins(monkeypatch):
    _clean_catalog_env(monkeypatch)
    monkeypatch.setenv("SYNC_CATALOG_DRY_RUN", "false")
    # CLI で --dry-run が立っていれば、env=false でも dry_run=True
    kwargs = _resolve_catalog_args(["--dry-run"])
    assert kwargs["dry_run"] is True


# ---------------------------------------------------------------------------
# cron で「固定日付に縛られない」設計のリグレッションテスト
#
# 以下の env が誤って .env に残されていても、scheduled run の挙動は
# 「日付未指定 (DMM API のフルレンジ + sort=date desc で最新から取得)」のまま
# でなければならない。値が無視されていることを担保する。
# ---------------------------------------------------------------------------

def test_catalog_ignores_fixed_date_envs(monkeypatch):
    """固定日付 env (GTE_DATE / LTE_DATE / START_DATE / END_DATE) は
    cron に対しては no-op であること。"""
    _clean_catalog_env(monkeypatch)
    monkeypatch.setenv("SYNC_CATALOG_GTE_DATE", "2020-01-01")
    monkeypatch.setenv("SYNC_CATALOG_LTE_DATE", "2020-12-31")
    monkeypatch.setenv("SYNC_CATALOG_START_DATE", "2010-01-01")
    monkeypatch.setenv("SYNC_CATALOG_END_DATE", "2010-12-31")
    kwargs = _resolve_catalog_args([])
    # incremental がデフォルト、日付は一切セットされない
    assert kwargs["mode"] == "incremental"
    assert kwargs["incremental_gte"] is None
    assert kwargs["incremental_lte"] is None
    assert kwargs["start_date"] is None
    assert kwargs["end_date"] is None


def test_catalog_ignores_mode_env(monkeypatch):
    """SYNC_CATALOG_MODE は受け付けない (cron が偶発的に full モードに
    切り替わって過剰負荷 / 古い日付ウィンドウに固定されるのを防ぐ)。"""
    _clean_catalog_env(monkeypatch)
    monkeypatch.setenv("SYNC_CATALOG_MODE", "full")
    kwargs = _resolve_catalog_args([])
    assert kwargs["mode"] == "incremental"


def test_catalog_full_mode_only_via_cli(monkeypatch):
    """full モードと固定日付は CLI からだけ指定できる (手動バックフィル用)。"""
    _clean_catalog_env(monkeypatch)
    kwargs = _resolve_catalog_args([
        "--mode", "full",
        "--start-date", "2025-01-01",
        "--end-date", "2025-06-30",
    ])
    assert kwargs["mode"] == "full"
    assert kwargs["start_date"] == date(2025, 1, 1)
    assert kwargs["end_date"] == date(2025, 6, 30)


# ---------------------------------------------------------------------------
# sync_actress_profiles CLI / env resolution
# ---------------------------------------------------------------------------

def _clean_actress_env(monkeypatch):
    for k in (
        "SYNC_ACTRESS_LIMIT",
        "SYNC_ACTRESS_ONLY_MISSING",
        "SYNC_ACTRESS_DRY_RUN",
    ):
        monkeypatch.delenv(k, raising=False)


def test_actress_defaults_when_nothing_set(monkeypatch):
    _clean_actress_env(monkeypatch)
    kwargs = _resolve_actress_args([])
    assert kwargs["limit"] is None
    assert kwargs["only_missing"] is False
    assert kwargs["dry_run"] is False


def test_actress_env_overrides(monkeypatch):
    _clean_actress_env(monkeypatch)
    monkeypatch.setenv("SYNC_ACTRESS_LIMIT", "100")
    monkeypatch.setenv("SYNC_ACTRESS_ONLY_MISSING", "true")
    kwargs = _resolve_actress_args([])
    assert kwargs["limit"] == 100
    assert kwargs["only_missing"] is True


def test_actress_cli_only_missing_wins_over_env_false(monkeypatch):
    _clean_actress_env(monkeypatch)
    monkeypatch.setenv("SYNC_ACTRESS_ONLY_MISSING", "false")
    kwargs = _resolve_actress_args(["--only-missing"])
    assert kwargs["only_missing"] is True


def test_actress_cli_limit_overrides_env(monkeypatch):
    _clean_actress_env(monkeypatch)
    monkeypatch.setenv("SYNC_ACTRESS_LIMIT", "100")
    kwargs = _resolve_actress_args(["--limit", "5"])
    assert kwargs["limit"] == 5


def test_actress_invalid_env_limit_exits(monkeypatch):
    _clean_actress_env(monkeypatch)
    monkeypatch.setenv("SYNC_ACTRESS_LIMIT", "0")
    with pytest.raises(SystemExit):
        _resolve_actress_args([])
