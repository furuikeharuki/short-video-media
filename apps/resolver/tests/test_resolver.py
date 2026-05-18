"""resolver.extract_mp4_url のユニットテスト。

Playwright の実体には接続しない。Browser / Context / Page をモック化して
コアロジックのブランチ (正常系, NotFound, Upstream, Timeout) をカバーする。
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.resolver import (
    ResolveNotFound,
    ResolveTimeout,
    ResolveUpstream,
    extract_mp4_url,
)


# ---------------------------------------------------------------------------
# Helpers: Playwright 互換のモックを組み立てる
# ---------------------------------------------------------------------------


def _make_page(
    *,
    evaluate_returns: object = None,
    captured_mp4: list[str] | None = None,
    current_url: str = "https://www.dmm.co.jp/litevideo/...",
    goto_raises: Exception | None = None,
) -> MagicMock:
    """1 ページ分のモックを作る。

    Args:
        evaluate_returns: page.evaluate() の戻り値 (None なら見つからない)
        captured_mp4: on_request コールバックに渡す URL のリスト
        current_url: page.url が返す値
        goto_raises: page.goto() が送出する例外
    """
    page = MagicMock()
    page.url = current_url

    # request イベントハンドラを記憶しておく
    listeners: dict[str, list] = {"request": []}

    def on(event_name, handler):
        listeners.setdefault(event_name, []).append(handler)

    page.on = MagicMock(side_effect=on)

    async def _goto(*_a, **_kw):
        if goto_raises:
            raise goto_raises
        # navigation 後に network capture を発火させる
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
    """browser.new_context() → context.new_page() の経路をモック化。"""
    context = MagicMock()
    context.new_page = AsyncMock(return_value=page)
    context.add_cookies = AsyncMock(return_value=None)
    context.close = AsyncMock(return_value=None)

    browser = MagicMock()
    browser.new_context = AsyncMock(return_value=context)
    return browser


# ---------------------------------------------------------------------------
# テストケース
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_extract_returns_mp4_url_from_video_src():
    """<video src> から MP4 URL が取得できる正常系。"""
    page = _make_page(
        evaluate_returns="https://cc3001.dmm.co.jp/pv/abc/cid_mhb_w.mp4",
    )
    browser = _make_browser(page)

    result = await extract_mp4_url(browser, "1sun00052a", "affi-001")

    assert result.content_id == "1sun00052a"
    assert result.mp4_url == "https://cc3001.dmm.co.jp/pv/abc/cid_mhb_w.mp4"


@pytest.mark.asyncio
async def test_extract_returns_mp4_url_from_network_capture():
    """evaluate 失敗時にネットワーク監視からフォールバックする。"""
    captured = ["https://cc3001.dmm.co.jp/pv/xyz/cidmhb.mp4"]
    page = _make_page(evaluate_returns=None, captured_mp4=captured)
    browser = _make_browser(page)

    result = await extract_mp4_url(browser, "nhd00019", "affi-001")
    assert result.mp4_url == captured[0]


@pytest.mark.asyncio
async def test_extract_normalizes_protocol_relative_url():
    """`//` で始まる URL は `https:` 付きで返る。"""
    page = _make_page(
        evaluate_returns="//cc3001.dmm.co.jp/pv/abc/cid_mhb_w.mp4",
    )
    browser = _make_browser(page)

    result = await extract_mp4_url(browser, "1sun00052a", "affi-001")
    assert result.mp4_url.startswith("https://cc3001.dmm.co.jp/")


@pytest.mark.asyncio
async def test_extract_raises_not_found_when_no_mp4():
    """<video> もネットワークもヒットなし → ResolveNotFound。"""
    page = _make_page(evaluate_returns=None, captured_mp4=[])
    browser = _make_browser(page)

    with pytest.raises(ResolveNotFound):
        await extract_mp4_url(browser, "missing_cid", "affi-001")


@pytest.mark.asyncio
async def test_extract_raises_upstream_on_region_block():
    """`not-available-in-your-region` にリダイレクトされたら ResolveUpstream。"""
    page = _make_page(
        evaluate_returns="https://cc3001.dmm.co.jp/pv/abc/cid.mp4",
        current_url="https://www.dmm.co.jp/not-available-in-your-region/...",
    )
    browser = _make_browser(page)

    with pytest.raises(ResolveUpstream):
        await extract_mp4_url(browser, "any_cid", "affi-001")


@pytest.mark.asyncio
async def test_extract_raises_timeout_on_goto_timeout():
    """page.goto() がタイムアウト例外を投げたら ResolveTimeout。"""

    class FakeTimeout(Exception):
        pass

    page = _make_page(goto_raises=FakeTimeout("Timeout 15000ms exceeded"))
    browser = _make_browser(page)

    with pytest.raises(ResolveTimeout):
        await extract_mp4_url(browser, "slow_cid", "affi-001")


@pytest.mark.asyncio
async def test_extract_raises_upstream_on_other_goto_error():
    """goto がタイムアウト以外の例外 → ResolveUpstream。"""
    page = _make_page(goto_raises=RuntimeError("net::ERR_CONNECTION_REFUSED"))
    browser = _make_browser(page)

    with pytest.raises(ResolveUpstream):
        await extract_mp4_url(browser, "any_cid", "affi-001")
