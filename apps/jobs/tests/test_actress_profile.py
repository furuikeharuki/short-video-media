"""sync_actress_profiles の純粋関数だけ軽くテストする smoke test。"""
import asyncio
import sys
from datetime import date
from pathlib import Path
from typing import Any

import pytest

# apps/jobs/src を import パスに追加
_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[1]))

from src.sync_actress_profiles import (  # noqa: E402
    _parse_birthday,
    _parse_int,
    _swap_af_id,
    fetch_actress,
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


class _FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200):
        self._payload = payload
        self.status_code = status_code
        self.text = str(payload)
        self.request = None

    def json(self) -> dict:
        return self._payload


class _FakeClient:
    def __init__(self, payload: dict):
        self._payload = payload
        self.calls: list[dict[str, Any]] = []

    async def get(self, url, params=None, timeout=None):  # noqa: ARG002
        self.calls.append({"url": url, "params": params})
        return _FakeResponse(self._payload)


def test_fetch_actress_accepts_status_string_200():
    """DMM API は result.status を文字列 '200' で返すケースがあり、
    その場合でも例外を投げず actress dict を返せること。
    """
    payload = {
        "result": {
            "status": "200",  # 文字列
            "result_count": 1,
            "total_count": "1",
            "first_position": "1",
            "actress": [
                {"id": "1092211", "name": "足立友梨", "ruby": "あだちゆり"},
            ],
        }
    }
    client = _FakeClient(payload)
    result = asyncio.run(
        fetch_actress(
            client,  # type: ignore[arg-type]
            api_id="id",
            affiliate_id="af-990",
            actress_id="1092211",
        )
    )
    assert result is not None
    assert result["id"] == "1092211"
    assert result["name"] == "足立友梨"


def test_fetch_actress_raises_on_non_200_status():
    payload = {
        "result": {
            "status": "400",
            "message": "bad request",
            "actress": [],
        }
    }
    client = _FakeClient(payload)
    with pytest.raises(RuntimeError, match="status=400"):
        asyncio.run(
            fetch_actress(
                client,  # type: ignore[arg-type]
                api_id="id",
                affiliate_id="af-990",
                actress_id="1",
            )
        )
