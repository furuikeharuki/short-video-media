"""sync_actress_profiles の純粋関数だけ軽くテストする smoke test。"""
import sys
from datetime import date
from pathlib import Path

# apps/jobs/src を import パスに追加
_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[1]))

from src.sync_actress_profiles import (  # noqa: E402
    _parse_birthday,
    _parse_int,
    _swap_af_id,
)


def test_parse_int_empty_string():
    assert _parse_int("") is None
    assert _parse_int(None) is None
    assert _parse_int("85") == 85
    assert _parse_int("1,234") == 1234


def test_parse_birthday():
    assert _parse_birthday("1995-01-01") == date(1995, 1, 1)
    assert _parse_birthday("1990/12/25") == date(1990, 12, 25)
    assert _parse_birthday("1990-12-25 00:00:00") == date(1990, 12, 25)
    assert _parse_birthday(None) is None
    assert _parse_birthday("") is None
    assert _parse_birthday("invalid") is None


def test_swap_af_id_replaces_existing():
    url = "http://www.dmm.co.jp/digital/videoa/-/list/=/article=actress/id=123/affiliate=demo-990"
    out = _swap_af_id(url, "mysite-001")
    assert "affiliate=mysite-001" in out
    assert "affiliate=demo-990" not in out


def test_swap_af_id_none_passthrough():
    assert _swap_af_id(None, "mysite-001") is None


def test_swap_af_id_no_match_returns_original():
    url = "https://example.com/no-affiliate-here"
    out = _swap_af_id(url, "mysite-001")
    assert out == url
