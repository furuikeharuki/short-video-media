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
    """bitrates にビットレートキーが無いケースはサフィックスのランクで low/high を推定する。

    サフィックスの並びは sm_w < dm_w < dmb_w < mhb_w (DMM の慣習)。
    旧テーブルでは `_dmb_w` が誤って最低として扱われ、`_dmb_w.mp4` しか
    返さない作品で `high_mp4_url` が中画質に固定される事故があった
    (PR #200 で修正)。
    """
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
    # 修正後: low は最低 (_dm_w)、high は最高 (_mhb_w)。
    assert result.low_mp4_url == "https://cc3001.dmm.co.jp/pv/aa/aa_dm_w.mp4"
    assert result.high_mp4_url == "https://cc3001.dmm.co.jp/pv/aa/aa_mhb_w.mp4"
    # primary は args.src を優先 (既存挙動互換)
    assert result.mp4_url == "https://cc3001.dmm.co.jp/pv/aa/aa_mhb_w.mp4"


@pytest.mark.asyncio
async def test_extract_suffix_rank_dmb_higher_than_dm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`_dmb_w` は `_dm_w` より高画質 (DMM 命名規則)。

    旧テーブルは `_dmb_w` を最低として扱っていたため、bitrate キーが無い
    レスポンスで `_dm_w` と `_dmb_w` の 2 候補があっても high=`_dm_w` を
    選んでしまい、ユーザーには中画質ではなく低画質が再生されていた。
    """
    raw_html = (
        '<script>var args = {'
        '"src": "https://cc3001.dmm.co.jp/pv/x/y_dm_w.mp4",'
        '"bitrates": ['
        '{"src": "//cc3001.dmm.co.jp/pv/x/y_dm_w.mp4"},'
        '{"src": "//cc3001.dmm.co.jp/pv/x/y_dmb_w.mp4"}'
        ']};</script>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("dmb_vs_dm", "affi-001")
    assert result.low_mp4_url == "https://cc3001.dmm.co.jp/pv/x/y_dm_w.mp4"
    assert result.high_mp4_url == "https://cc3001.dmm.co.jp/pv/x/y_dmb_w.mp4"


@pytest.mark.asyncio
async def test_extract_bitrates_descending_order_still_picks_low_smallest(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """args.bitrates が降順 (高ビットレート先頭) で並んでいても low/high が逆転しない。

    DMM html5_player は実際には bitrates を降順で返すケースがあるため、
    昇順前提のソートがあっても low_mp4_url = 最低ビットレート、high_mp4_url = 最高
    ビットレートに振り分けられることを担保する。「最初は高画質→低画質に切り替わる」
    というユーザー報告 (PR #167 後) の再発防止用回帰テスト。
    """
    raw_html = (
        '<script>var args = {'
        '"src": "https://cc3001.dmm.co.jp/pv/x/y_mhb_w.mp4",'
        '"bitrates": ['
        '{"bitrate": 1500, "src": "//cdn/high_mhb_w.mp4"},'
        '{"bitrate": 800, "src": "//cdn/mid_dm_w.mp4"},'
        '{"bitrate": 300, "src": "//cdn/low_dmb_w.mp4"}'
        ']};</script>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("descending_bitrates", "affi-001")
    # 入力順に関わらず low = 最小ビットレート、high = 最大ビットレート。
    assert result.low_mp4_url == "https://cdn/low_dmb_w.mp4"
    assert result.high_mp4_url == "https://cdn/high_mhb_w.mp4"
    # low != high (= スワップが有効に発火する)。
    assert result.low_mp4_url != result.high_mp4_url


@pytest.mark.asyncio
async def test_extract_bitrates_with_string_bitrate_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """bitrate キーが文字列値 ("1500" 等) でも数値として比較される。

    DMM html5_player では bitrate がしばしば文字列で埋め込まれているため、
    `int(float(...))` でパースし low/high が正しく振り分けられることを担保する。
    """
    raw_html = (
        '<script>var args = {'
        '"src": "https://cc3001.dmm.co.jp/pv/x/y.mp4",'
        '"bitrates": ['
        '{"bitrate": "300", "src": "//cdn/low.mp4"},'
        '{"bitrate": "1500", "src": "//cdn/high.mp4"}'
        ']};</script>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("string_bitrates", "affi-001")
    assert result.low_mp4_url == "https://cdn/low.mp4"
    assert result.high_mp4_url == "https://cdn/high.mp4"


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


# ────────────────────────────────────────────────────────────────────
# コンパクトサフィックス (`<cid>sm.mp4` / `<cid>mhb.mp4` 等) のランク付け
# ────────────────────────────────────────────────────────────────────
# 本番ログ (PR #283 後) で `basename=sone00614sm.mp4` が high として選ばれていた
# ケースを救う。bitrate キーが無い + 候補全てが従来辞書外 (`_xxx_w.mp4` 形でない)
# のとき、`_suffix_rank` が全部 50 を返して安定ソートの末尾 (= 入力順最後) を
# high と誤判定していたのが原因。コンパクト形のティアを認識すれば mhb > dmb >
# dm > sm でランク差が付き、最高ビットレートを選べる。


@pytest.mark.asyncio
async def test_extract_compact_suffix_picks_mhb_over_sm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`<cid>sm.mp4` / `<cid>mhb.mp4` のコンパクト形でも mhb を high に選ぶ。

    本番 sone00614 の再発防止用。bitrate キーが無く 4 候補すべてが
    コンパクト形のケースで、high が mhb / low が sm に振り分けられることを
    担保する。
    """
    raw_html = (
        '<script>var args = {'
        '"src": "https://cc3001.dmm.co.jp/pv/so/sone00614sm.mp4",'
        '"bitrates": ['
        '{"src": "//cc3001.dmm.co.jp/pv/so/sone00614sm.mp4"},'
        '{"src": "//cc3001.dmm.co.jp/pv/so/sone00614dm.mp4"},'
        '{"src": "//cc3001.dmm.co.jp/pv/so/sone00614dmb.mp4"},'
        '{"src": "//cc3001.dmm.co.jp/pv/so/sone00614mhb.mp4"}'
        ']};</script>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("sone00614", "affi-001")
    assert result.low_mp4_url == "https://cc3001.dmm.co.jp/pv/so/sone00614sm.mp4"
    assert result.high_mp4_url == "https://cc3001.dmm.co.jp/pv/so/sone00614mhb.mp4"
    # primary は args.src 優先 (既存挙動)。
    assert result.mp4_url == "https://cc3001.dmm.co.jp/pv/so/sone00614sm.mp4"


@pytest.mark.asyncio
async def test_extract_compact_suffix_sm_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """コンパクト形 sm 単独のとき low/high が同じ URL に揃う (single-bitrate 扱い)。"""
    raw_html = (
        '<script>var args = {'
        '"src": "https://cc3001.dmm.co.jp/pv/so/sone00614sm.mp4",'
        '"bitrates": ['
        '{"src": "//cc3001.dmm.co.jp/pv/so/sone00614sm.mp4"}'
        ']};</script>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("sone00614_sm_only", "affi-001")
    assert result.low_mp4_url == "https://cc3001.dmm.co.jp/pv/so/sone00614sm.mp4"
    assert result.high_mp4_url == "https://cc3001.dmm.co.jp/pv/so/sone00614sm.mp4"


@pytest.mark.asyncio
async def test_extract_mixed_compact_and_underscored_suffix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """コンパクト形と `_xxx_w.mp4` 形が同じ bitrates 配列に混ざっていても破綻しない。

    実 DMM ではほぼ起きないが、`_suffix_rank` が両形式で同一ランクを返すことを
    担保するための保険テスト。
    """
    raw_html = (
        '<script>var args = {'
        '"src": "https://cc3001.dmm.co.jp/pv/x/y_mhb_w.mp4",'
        '"bitrates": ['
        '{"src": "//cc3001.dmm.co.jp/pv/x/abc123sm.mp4"},'
        '{"src": "//cc3001.dmm.co.jp/pv/x/y_dmb_w.mp4"},'
        '{"src": "//cc3001.dmm.co.jp/pv/x/y_mhb_w.mp4"}'
        ']};</script>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("mixed_forms", "affi-001")
    # sm (コンパクト 10) が low、mhb_w (90) が high。
    assert result.low_mp4_url == "https://cc3001.dmm.co.jp/pv/x/abc123sm.mp4"
    assert result.high_mp4_url == "https://cc3001.dmm.co.jp/pv/x/y_mhb_w.mp4"


@pytest.mark.asyncio
async def test_extract_compact_suffix_descending_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """コンパクト形でも入力が降順 (mhb 先頭) のとき high/low が逆転しない。

    本番 sone00614 の元バグは「全候補が辞書外でランクが揃い、安定ソートの末尾
    (= 入力順最後) が high になる」だった。コンパクト形をランク認識した後は
    入力順に依存せず最大ティアが high になることを担保する。
    """
    raw_html = (
        '<script>var args = {'
        '"src": "https://cc3001.dmm.co.jp/pv/so/sone00614mhb.mp4",'
        '"bitrates": ['
        '{"src": "//cc3001.dmm.co.jp/pv/so/sone00614mhb.mp4"},'
        '{"src": "//cc3001.dmm.co.jp/pv/so/sone00614dmb.mp4"},'
        '{"src": "//cc3001.dmm.co.jp/pv/so/sone00614dm.mp4"},'
        '{"src": "//cc3001.dmm.co.jp/pv/so/sone00614sm.mp4"}'
        ']};</script>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("sone00614_desc", "affi-001")
    assert result.high_mp4_url == "https://cc3001.dmm.co.jp/pv/so/sone00614mhb.mp4"
    assert result.low_mp4_url == "https://cc3001.dmm.co.jp/pv/so/sone00614sm.mp4"


@pytest.mark.asyncio
async def test_direct_fallback_prefers_compact_mhb(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """args が壊れている場合の直リンクフォールバックでも、コンパクト mhb を primary に選ぶ。

    旧実装は primary を `"mhb_w.mp4" in u` だけで選んでいたため、コンパクト形
    (`<cid>mhb.mp4`) しか HTML に居ないケースで primary が先頭の小ファイル
    (例: sm) に流れていた。`_suffix_rank >= 90` 判定に置き換えたことで救う。
    """
    # args は壊した状態にして直リンクフォールバック経路を通す
    raw_html = (
        '<script>var args = {</script>'
        '<a href="https://cc3001.dmm.co.jp/pv/so/sone00614sm.mp4">low</a>'
        '<a href="https://cc3001.dmm.co.jp/pv/so/sone00614dmb.mp4">mid</a>'
        '<a href="https://cc3001.dmm.co.jp/pv/so/sone00614mhb.mp4">high</a>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("sone00614_direct", "affi-001")
    # primary は mhb を優先 (先頭の sm ではない)。
    assert result.mp4_url == "https://cc3001.dmm.co.jp/pv/so/sone00614mhb.mp4"
    assert result.low_mp4_url == "https://cc3001.dmm.co.jp/pv/so/sone00614sm.mp4"
    assert result.high_mp4_url == "https://cc3001.dmm.co.jp/pv/so/sone00614mhb.mp4"


@pytest.mark.asyncio
async def test_extract_compact_suffix_with_query_string(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """署名クエリ付き URL でも basename 末尾だけを見て tier を判定する。"""
    raw_html = (
        '<script>var args = {'
        '"src": "https://cc3001.dmm.co.jp/pv/so/sone00614sm.mp4?token=abc",'
        '"bitrates": ['
        '{"src": "//cc3001.dmm.co.jp/pv/so/sone00614sm.mp4?token=abc"},'
        '{"src": "//cc3001.dmm.co.jp/pv/so/sone00614mhb.mp4?token=def"}'
        ']};</script>'
    )
    handler = _two_stage_handler(
        litevideo_body=_litevideo_html(),
        player_body=raw_html,
    )
    _install_transport(monkeypatch, handler)

    result = await extract_mp4_url("sone00614_query", "affi-001")
    assert result.low_mp4_url == (
        "https://cc3001.dmm.co.jp/pv/so/sone00614sm.mp4?token=abc"
    )
    assert result.high_mp4_url == (
        "https://cc3001.dmm.co.jp/pv/so/sone00614mhb.mp4?token=def"
    )


def test_suffix_rank_unit_known_and_compact() -> None:
    """`_suffix_rank` の単体テスト。既知 4 種 + コンパクト 4 種 + 偽陽性パターン。"""
    from app.resolver.extractor import _suffix_rank

    # 既存 `_xxx_w.mp4` 形 (substring match なので path 途中でも有効)。
    assert _suffix_rank("https://cdn/pv/x/y_sm_w.mp4") == 10
    assert _suffix_rank("https://cdn/pv/x/y_dm_w.mp4") == 30
    assert _suffix_rank("https://cdn/pv/x/y_dmb_w.mp4") == 60
    assert _suffix_rank("https://cdn/pv/x/y_mhb_w.mp4") == 90

    # コンパクト形 (basename 末尾だけ)。
    assert _suffix_rank("https://cdn/pv/so/sone00614sm.mp4") == 10
    assert _suffix_rank("https://cdn/pv/so/sone00614dm.mp4") == 30
    assert _suffix_rank("https://cdn/pv/so/sone00614dmb.mp4") == 60
    assert _suffix_rank("https://cdn/pv/so/sone00614mhb.mp4") == 90

    # クエリ付き basename も同じく判定可能。
    assert _suffix_rank("https://cdn/pv/so/sone00614mhb.mp4?token=xxx") == 90

    # 既存挙動互換チェック: `_mhb_w.mp4` の前に小文字英字 (例 `amhb_w.mp4`) が
    # ある古 DMM 命名は、substring `_mhb_w.mp4` にも regex `(mhb)\.mp4$` にも
    # マッチしないので 50 のまま (既存挙動を変えない)。
    assert _suffix_rank("https://cdn/pv/abc/1sun00052amhb_w.mp4") == 50

    # 完全未知のサフィックスは 50 (既存挙動)。
    assert _suffix_rank("https://cdn/pv/x/y_w1080.mp4") == 50
    # `smhb.mp4` のような `mhb` の直前が小文字英字のケースは偽陽性を避け 50。
    # (DMM では発生しないが正規表現の安全性チェック)
    assert _suffix_rank("https://cdn/pv/x/wrongsmhb.mp4") == 50
