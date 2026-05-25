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
# 旧 Playwright 経由でだけ拾えていたページ形状をカバーする回帰テスト群
# (h-1186etqr00128 / h-1416ad00199 等で実観測された崩れパターン)
# ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_extract_args_without_var_keyword(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`args = {...}` (var 無し) でも src を取り出せる。"""
    raw_html = (
        '<script>args = {"src": "https://cc3001.dmm.co.jp/pv/a/b.mp4"};</script>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("h_1186etqr00128", "affi-001")
    assert result.mp4_url == "https://cc3001.dmm.co.jp/pv/a/b.mp4"


@pytest.mark.asyncio
async def test_extract_args_with_nested_objects_and_arrays(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`bitrates: [{...}]` / `controls: {...}` を含むネストオブジェクトでも壊れない。

    旧実装の ``\\{.*?\\}`` 非貪欲マッチは最初の `}` で止まるためここで失敗していた。
    バランス括弧スキャナーへの移行で救われるパターン。
    """
    raw_html = (
        '<script>var args = {'
        '"src": "https://cc3001.dmm.co.jp/pv/x/y.mp4",'
        '"bitrates": [{"bitrate": 300, "src": "//low/y_low.mp4"},'
        '{"bitrate": 1000, "src": "//hi/y_hi.mp4"}],'
        '"controls": {"volume": true, "fullscreen": true},'
        '"poster": "//pics/y.jpg"'
        '};</script>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("h_1416ad00199", "affi-001")
    assert result.mp4_url == "https://cc3001.dmm.co.jp/pv/x/y.mp4"
    # bitrates から low/high が抽出されている。primary (= args.src) は据え置き。
    assert result.low_mp4_url == "https://low/y_low.mp4"
    assert result.high_mp4_url == "https://hi/y_hi.mp4"


@pytest.mark.asyncio
async def test_extract_picks_low_high_from_bitrates_with_suffix_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """bitrates にビットレートキーが無いケースはサフィックスのランクで low/high を推定する。"""
    raw_html = (
        '<script>var args = {'
        '"src": "https://cc3001.dmm.co.jp/pv/aa/aa_mhb_w.mp4",'
        '"bitrates": ['
        '{"src": "//cc3001.dmm.co.jp/pv/aa/aa_dmb_w.mp4"},'
        '{"src": "//cc3001.dmm.co.jp/pv/aa/aa_dm_w.mp4"},'
        '{"src": "//cc3001.dmm.co.jp/pv/aa/aa_mhb_w.mp4"}'
        ']};</script>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("bitrate_no_key", "affi-001")
    assert result.low_mp4_url == "https://cc3001.dmm.co.jp/pv/aa/aa_dmb_w.mp4"
    assert result.high_mp4_url == "https://cc3001.dmm.co.jp/pv/aa/aa_mhb_w.mp4"
    # primary は args.src を優先 (既存挙動互換)
    assert result.mp4_url == "https://cc3001.dmm.co.jp/pv/aa/aa_mhb_w.mp4"


@pytest.mark.asyncio
async def test_extract_single_bitrate_keeps_low_equal_high(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """候補が 1 つしか無いときは low/high が同じ URL になる (スワップは web 側でスキップされる)。"""
    raw_html = (
        '<script>var args = {"src": "https://cc3001.dmm.co.jp/pv/x/single.mp4"};</script>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("single_cid", "affi-001")
    assert result.mp4_url == "https://cc3001.dmm.co.jp/pv/x/single.mp4"
    assert result.low_mp4_url == result.high_mp4_url == result.mp4_url


@pytest.mark.asyncio
async def test_extract_direct_fallback_returns_low_and_high(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`args` 無しの直リンクフォールバックでも、サフィックスから low/high を選び分ける。"""
    raw_html = (
        '<html><body>'
        '<source src="//cc3001.dmm.co.jp/pv/zz/q_dmb_w.mp4">'
        '<source src="//cc3001.dmm.co.jp/pv/zz/q_mhb_w.mp4">'
        '</body></html>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("direct_fb_cid", "affi-001")
    assert result.low_mp4_url == "https://cc3001.dmm.co.jp/pv/zz/q_dmb_w.mp4"
    assert result.high_mp4_url == "https://cc3001.dmm.co.jp/pv/zz/q_mhb_w.mp4"
    # primary は _mhb_w.mp4 優先 (既存挙動)
    assert result.mp4_url == "https://cc3001.dmm.co.jp/pv/zz/q_mhb_w.mp4"


@pytest.mark.asyncio
async def test_extract_args_without_trailing_semicolon(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """末尾 `;` が無い (close `}` のみ) でも抽出できる。"""
    raw_html = (
        '<script>var args = {"src": "https://cc3001.dmm.co.jp/pv/n/o.mp4"}</script>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("h_1186etqr00127", "affi-001")
    assert result.mp4_url == "https://cc3001.dmm.co.jp/pv/n/o.mp4"


@pytest.mark.asyncio
async def test_extract_args_minified_single_line(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ミニファイされた 1 行 JS でもバランス括弧で正しく切り出せる。"""
    raw_html = (
        'function init(){var args={"src":"https:\\/\\/cc3001.dmm.co.jp\\/pv\\/m\\/n.mp4",'
        '"bitrates":[{"bitrate":300}]};player.setup(args);}'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("h_1416ad00198", "affi-001")
    assert result.mp4_url == "https://cc3001.dmm.co.jp/pv/m/n.mp4"


@pytest.mark.asyncio
async def test_direct_mp4_fallback_when_args_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`args = {...}` が無くても HTML 内の cc3001 直リンクを拾えるフォールバック。"""
    raw_html = (
        '<html><body>'
        '<video src="https:\\/\\/cc3001.dmm.co.jp\\/pv\\/zz\\/q_mhb_w.mp4"></video>'
        '</body></html>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("h_1186etqr00128", "affi-001")
    assert result.mp4_url == "https://cc3001.dmm.co.jp/pv/zz/q_mhb_w.mp4"


@pytest.mark.asyncio
async def test_direct_mp4_fallback_prefers_mhb_w(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """フォールバック時に `_mhb_w.mp4` (高ビットレート) を優先する。"""
    raw_html = (
        '<html><body>'
        '<source src="//cc3001.dmm.co.jp/pv/a/sample_low.mp4">'
        '<source src="//cc3001.dmm.co.jp/pv/a/sample_mhb_w.mp4">'
        '</body></html>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("h_1416ad00199", "affi-001")
    assert result.mp4_url == "https://cc3001.dmm.co.jp/pv/a/sample_mhb_w.mp4"


@pytest.mark.asyncio
async def test_direct_mp4_fallback_with_query_string(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """クエリ付き MP4 URL もフォールバックで拾える。"""
    raw_html = (
        '<html><body>'
        'data-mp4="https://cc3001.dmm.co.jp/pv/aa/bb_mhb_w.mp4?token=xyz"'
        '</body></html>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("h_1416ad00199", "affi-001")
    assert result.mp4_url == "https://cc3001.dmm.co.jp/pv/aa/bb_mhb_w.mp4?token=xyz"


@pytest.mark.asyncio
async def test_iframe_with_single_quoted_src(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """iframe の src がシングルクォートでも digitalapi URL を拾える。"""
    lite_html = (
        "<html><body>"
        f"<iframe src='{_IFRAME_URL}' width='720'></iframe>"
        "</body></html>"
    )
    mp4 = "https://cc3001.dmm.co.jp/pv/q/q.mp4"
    handler = _two_stage_handler(
        litevideo_body=lite_html,
        player_body=_player_html(mp4),
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("any_cid", "affi-001")
    assert result.mp4_url == mp4


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
async def test_missing_args_and_no_mp4_raises_not_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """args も直接 MP4 URL も無いケースは NotFound。"""
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body="<html><body>no args here</body></html>",
    )
    _install_transport(monkeypatch, handler)

    with pytest.raises(ResolveNotFound):
        await extract_mp4_url("missing_cid", "affi-001")


@pytest.mark.asyncio
async def test_args_without_src_falls_back_to_direct_mp4(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`args.src` が無くても HTML 内に MP4 URL があればフォールバックで救われる。"""
    raw_html = (
        '<script>var args = {"poster": "//x/y.jpg"};</script>'
        '<source src="//cc3001.dmm.co.jp/pv/p/q_mhb_w.mp4">'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("any_cid", "affi-001")
    assert result.mp4_url == "https://cc3001.dmm.co.jp/pv/p/q_mhb_w.mp4"


@pytest.mark.asyncio
async def test_args_without_src_and_no_mp4_raises_not_found(
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
async def test_invalid_args_json_with_no_mp4_raises_upstream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """args オブジェクトが JSON として壊れていて MP4 も無いなら Upstream エラー。"""
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body="<script>var args = {not valid json here};</script>",
    )
    _install_transport(monkeypatch, handler)

    with pytest.raises(ResolveUpstream):
        await extract_mp4_url("bad_json_cid", "affi-001")


@pytest.mark.asyncio
async def test_invalid_args_json_falls_back_to_direct_mp4(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """args が壊れていても HTML 内に MP4 URL があれば回復する。"""
    raw_html = (
        '<script>var args = {not valid json here};</script>'
        '<source src="//cc3001.dmm.co.jp/pv/f/g_mhb_w.mp4">'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("recover_cid", "affi-001")
    assert result.mp4_url == "https://cc3001.dmm.co.jp/pv/f/g_mhb_w.mp4"


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
