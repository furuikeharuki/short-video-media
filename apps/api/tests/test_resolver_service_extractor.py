"""app.resolver.extractor (ピュア httpx 抽出ロジック) のテスト。

DMM への実 HTTP 通信は行わず、httpx.MockTransport で

  - litevideo ページ (digitalapi iframe を含む HTML)
  - html5_player ページ (``var args = {...}`` を含む HTML)

の二段レスポンスを差し替えてコアロジックを検証する。
"""
from __future__ import annotations

import httpx
import pytest

from app.resolver.extractor import (
    ResolveNotFound,
    ResolveTimeout,
    ResolveUpstream,
    extract_mp4_url,
)


_IFRAME_URL = (
    "https://www.dmm.co.jp/service/digitalapi/-/html5_player/"
    "=/cid=1sun00052a/mtype=AhRVShI_/service=litevideo/floor=videoa/"
)


def _litevideo_html(iframe_url: str = _IFRAME_URL) -> str:
    return (
        '<!DOCTYPE html><html><body>'
        f'<iframe src="{iframe_url}" width="720" height="480"></iframe>'
        '</body></html>'
    )


def _player_html(src: str) -> str:
    # 実 DMM HTML を模した最小サンプル。
    return (
        '<!DOCTYPE html><html><head></head><body>'
        '<script>'
        'var args = {"src": "' + src.replace("/", "\\/") + '",'
        '"poster": "//pics.dmm.co.jp/digital/video/1sun00052/1sun00052ajp.jpg",'
        '"title": "sample"};'
        '</script></body></html>'
    )


def _install_transport(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    """httpx.AsyncClient が使う transport を MockTransport に差し替える。"""
    transport = httpx.MockTransport(handler)
    real_init = httpx.AsyncClient.__init__

    def patched_init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs["transport"] = transport
        real_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", patched_init)


def _two_stage_handler(
    *,
    litevideo_body: str | None = None,
    litevideo_status: int = 200,
    player_body: str | None = None,
    player_status: int = 200,
):
    """litevideo → player の 2 リクエストに順番にレスポンスを返すハンドラ。"""

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.startswith("https://www.dmm.co.jp/litevideo/"):
            return httpx.Response(
                litevideo_status,
                text=litevideo_body if litevideo_body is not None else "",
            )
        if url.startswith("https://www.dmm.co.jp/service/digitalapi"):
            return httpx.Response(
                player_status,
                text=player_body if player_body is not None else "",
            )
        return httpx.Response(404, text="unexpected url: " + url)

    return handler


# ────────────────────────────────────────────────────────────────────
# 正常系
# ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_extract_returns_mp4_url_from_args(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mp4 = "https://cc3001.dmm.co.jp/pv/abc/1sun00052amhb_w.mp4"
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=_player_html(mp4),
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("1sun00052a", "affi-001")
    assert result.content_id == "1sun00052a"
    assert result.mp4_url == mp4


@pytest.mark.asyncio
async def test_extract_normalizes_protocol_relative_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``args.src`` が ``//host/...`` で始まるとき ``https:`` を前置する。"""
    relative = "//cc3001.dmm.co.jp/pv/abc/1sun00052amhb_w.mp4"
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=_player_html(relative),
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("1sun00052a", "affi-001")
    assert result.mp4_url == "https:" + relative


@pytest.mark.asyncio
async def test_extract_handles_escaped_forward_slashes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``args.src`` に ``\\/`` エスケープが残っていてもアンエスケープされる。"""
    # 実 DMM ではしばしば src が ``"https:\/\/cc3001..."`` のように
    # forward slash がエスケープされた形で返ってくる。json.loads がほとんどの
    # ケースで剥がすが、念のため明示的にアンエスケープする挙動を担保する。
    raw_html = (
        '<script>var args = {"src": "https:\\/\\/cc3001.dmm.co.jp\\/pv\\/x\\/y.mp4"};'
        '</script>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("1sun00052a", "affi-001")
    assert result.mp4_url == "https://cc3001.dmm.co.jp/pv/x/y.mp4"


# ────────────────────────────────────────────────────────────────────
# エラー系
# ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_missing_iframe_raises_not_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = _two_stage_handler(
        litevideo_body="<html><body>no iframe here</body></html>",
        player_body=_player_html("https://cc3001.dmm.co.jp/x.mp4"),
    )
    _install_transport(monkeypatch, handler)

    with pytest.raises(ResolveNotFound):
        await extract_mp4_url("missing_cid", "affi-001")


@pytest.mark.asyncio
async def test_missing_args_raises_not_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body="<html><body>no args here</body></html>",
    )
    _install_transport(monkeypatch, handler)

    with pytest.raises(ResolveNotFound):
        await extract_mp4_url("missing_cid", "affi-001")


@pytest.mark.asyncio
async def test_args_without_src_raises_not_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body='<script>var args = {"poster": "//x/y.jpg"};</script>',
    )
    _install_transport(monkeypatch, handler)

    with pytest.raises(ResolveNotFound):
        await extract_mp4_url("missing_cid", "affi-001")


@pytest.mark.asyncio
async def test_invalid_args_json_raises_upstream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body="<script>var args = {not valid json};</script>",
    )
    _install_transport(monkeypatch, handler)

    with pytest.raises(ResolveUpstream):
        await extract_mp4_url("bad_json_cid", "affi-001")


@pytest.mark.asyncio
async def test_litevideo_5xx_raises_upstream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = _two_stage_handler(
        litevideo_body="server error",
        litevideo_status=503,
    )
    _install_transport(monkeypatch, handler)

    with pytest.raises(ResolveUpstream):
        await extract_mp4_url("any_cid", "affi-001")


@pytest.mark.asyncio
async def test_player_4xx_raises_upstream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_status=404,
        player_body="not found",
    )
    _install_transport(monkeypatch, handler)

    with pytest.raises(ResolveUpstream):
        await extract_mp4_url("any_cid", "affi-001")


@pytest.mark.asyncio
async def test_timeout_raises_resolve_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out")

    _install_transport(monkeypatch, handler)

    with pytest.raises(ResolveTimeout):
        await extract_mp4_url("slow_cid", "affi-001")


@pytest.mark.asyncio
async def test_http_error_raises_upstream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    _install_transport(monkeypatch, handler)

    with pytest.raises(ResolveUpstream):
        await extract_mp4_url("conn_refused", "affi-001")
