"""sync_catalog の純粋関数だけ軽くテストする smoke test。"""
import sys
from datetime import date
from pathlib import Path

# apps/jobs/src を import パスに追加
_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[1]))

from src.sync_catalog import (  # noqa: E402
    _build_affiliate_url,
    _build_content_id,
    _extract_price_list,
    _extract_review,
    _parse_date,
    _parse_float,
    _parse_int,
    _slugify,
)


def test_parse_int():
    assert _parse_int("123") == 123
    assert _parse_int("1,234") == 1234
    assert _parse_int(None) is None
    assert _parse_int("abc") is None


def test_parse_float():
    assert _parse_float("3.5") == 3.5
    assert _parse_float(None) is None


def test_parse_date():
    assert _parse_date("2026-05-17") == date(2026, 5, 17)
    assert _parse_date("2026-05-17 10:00:00") == date(2026, 5, 17)
    assert _parse_date("2026/05/17") == date(2026, 5, 17)
    assert _parse_date(None) is None
    assert _parse_date("invalid") is None


def test_build_affiliate_url():
    # videoa: デジタルビデオ (アダルト動画)
    url = _build_affiliate_url("nask00405", "videoa", "avshorts0512-990")
    assert url.startswith("https://www.dmm.co.jp/digital/videoa/")
    assert "cid=nask00405" in url
    assert "af_id=avshorts0512-990" in url
    # videoc: アマチュア
    url = _build_affiliate_url("smjx231", "videoc", "avshorts0512-990")
    assert url.startswith("https://www.dmm.co.jp/digital/videoc/")
    # goods: グッズ
    url = _build_affiliate_url("ho11992", "goods", "avshorts0512-990")
    assert url.startswith("https://www.dmm.co.jp/mono/goods/")
    # 未知 floor は videoa にフォールバック
    url = _build_affiliate_url("foo", "unknown", "af-990")
    assert "digital/videoa" in url


def test_slugify():
    # fallback が name と違うときは suffix として付与される (同名製品で slug が衝突しないよう)
    assert _slugify("ABC-123", "fallback") == "abc-123-fallback"
    # fallback と ascii 化後の name が一致する場合は suffix 不要
    assert _slugify("ABC-123", "abc-123") == "abc-123"
    # 日本語は ascii 化で空になるので fallback が使われる
    assert _slugify("あいうえお", "ho11992") == "ho11992"
    # 同名シリーズ "NTR" でも content_id が違えば slug がユニークになる
    assert _slugify("NTR", "183234") != _slugify("NTR", "183235")


def test_build_content_id():
    assert _build_content_id({"content_id": "abc123"}, "videoa") == "abc123"
    assert _build_content_id({"product_id": "pid456"}, "videoa") == "pid456"
    # 何も無いときは prefix + uuid
    cid = _build_content_id({}, "videoa")
    assert cid.startswith("videoa-")


def test_extract_review():
    cnt, avg = _extract_review({"review": {"count": "10", "average": "4.5"}})
    assert cnt == 10
    assert avg == 4.5

    cnt, avg = _extract_review({})
    assert cnt == 0
    assert avg is None


def test_extract_price_list():
    pl, pmin = _extract_price_list({
        "prices": {
            "price": "980",
            "list_price": "1980",
            "deliveries": {"delivery": [
                {"type": "stream", "price": "500"},
                {"type": "rental", "price": "300"},
            ]},
        }
    })
    assert pl["sale_price"] == 980
    assert pl["list_price"] == 1980
    assert pl["delivery_price"] == 500
    assert pl["rental_price"] == 300
    assert pmin == 300

    pl, pmin = _extract_price_list({})
    assert pl is None
    assert pmin is None
