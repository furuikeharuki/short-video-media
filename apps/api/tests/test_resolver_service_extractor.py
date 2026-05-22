"""resolver サービスのコアロジック (app.resolver.extractor) のテスト。

旧 apps/resolver/tests/test_resolver.py を apps/api パッケージへ移植したもの。
Playwright の実体には接続しない。Browser / Context / Page をモック化して
コアロジックのブランチ (正常系, NotFound, Upstream, Timeout) をカバーする。
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.resolver.extractor import (
    ResolveNotFound,
    ResolveTimeout,
    ResolveUpstream,
    extract_mp4_url,
)


def _make_page(
    *,
    evaluate_returns: object = None,
    captured_mp4: list[str] | None = None,
    current_url: str = "https://www.dmm.co.jp/litevideo/...",
    goto_raises: Exception | None = None,
) -> MagicMock:
    page = MagicMock()
    page.url = current_url
    listeners: dict[str, list] = {"request": []}

    def on(event_name, handler):
        listeners.setdefault(event_name, []).append(handler)

    page.on = MagicMock(side_effect=on)

    async def _goto(*_a, **_kw):
        if goto_raises:
            raise goto_raises
        for url in captured_mp4 or []:
            req = MagicMock()
            req.url = url
            for h in listeners["request"]:
                h(req)
        return None

    page.goto = AsyncMock(side_effect=_goto)
    page.evaluate = AsyncMock(return_value=evaluate_returns)
    page.wait_for_event = AsyncMock(return_value=None)
    return page


def _make_browser(page: MagicMock) -> MagicMock:
    context = MagicMock()
    context.new_page = AsyncMock(return_value=page)
    context.add_cookies = AsyncMock(return_value=None)
    context.close = AsyncMock(return_value=None)

    browser = MagicMock()
    browser.new_context = AsyncMock(return_value=context)
    return browser


@pytest.mark.asyncio
async def test_extract_returns_mp4_url_from_video_src():
    page = _make_page(
        evaluate_returns="https://cc3001.dmm.co.jp/pv/abc/cid_mhb_w.mp4",
    )
    browser = _make_browser(page)

    result = await extract_mp4_url(browser, "1sun00052a", "affi-001")

    assert result.content_id == "1sun00052a"
    assert result.mp4_url == "https://cc3001.dmm.co.jp/pv/abc/cid_mhb_w.mp4"


@pytest.mark.asyncio
async def test_extract_returns_mp4_url_from_network_capture():
    captured = ["https://cc3001.dmm.co.jp/pv/xyz/cidmhb.mp4"]
    page = _make_page(evaluate_returns=None, captured_mp4=captured)
    browser = _make_browser(page)

    result = await extract_mp4_url(browser, "nhd00019", "affi-001")
    assert result.mp4_url == captured[0]


@pytest.mark.asyncio
async def test_extract_normalizes_protocol_relative_url():
    page = _make_page(
        evaluate_returns="//cc3001.dmm.co.jp/pv/abc/cid_mhb_w.mp4",
    )
    browser = _make_browser(page)

    result = await extract_mp4_url(browser, "1sun00052a", "affi-001")
    assert result.mp4_url.startswith("https://cc3001.dmm.co.jp/")


@pytest.mark.asyncio
async def test_extract_raises_not_found_when_no_mp4():
    page = _make_page(evaluate_returns=None, captured_mp4=[])
    browser = _make_browser(page)

    with pytest.raises(ResolveNotFound):
        await extract_mp4_url(browser, "missing_cid", "affi-001")


@pytest.mark.asyncio
async def test_extract_raises_upstream_on_region_block():
    page = _make_page(
        evaluate_returns="https://cc3001.dmm.co.jp/pv/abc/cid.mp4",
        current_url="https://www.dmm.co.jp/not-available-in-your-region/...",
    )
    browser = _make_browser(page)

    with pytest.raises(ResolveUpstream):
        await extract_mp4_url(browser, "any_cid", "affi-001")


@pytest.mark.asyncio
async def test_extract_raises_timeout_on_goto_timeout():
    class FakeTimeout(Exception):
        pass

    page = _make_page(goto_raises=FakeTimeout("Timeout 15000ms exceeded"))
    browser = _make_browser(page)

    with pytest.raises(ResolveTimeout):
        await extract_mp4_url(browser, "slow_cid", "affi-001")


@pytest.mark.asyncio
async def test_extract_raises_upstream_on_other_goto_error():
    page = _make_page(goto_raises=RuntimeError("net::ERR_CONNECTION_REFUSED"))
    browser = _make_browser(page)

    with pytest.raises(ResolveUpstream):
        await extract_mp4_url(browser, "any_cid", "affi-001")
