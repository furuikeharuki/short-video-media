r"""DMM litevideo iframe から MP4 直リンク URL を抽出するコアロジック。

以前は Playwright で iframe ページを開いて <video> 要素や network から
取得していたが、DMM 側の html5_player ページが返す HTML に
``var args = {...}`` の形で MP4 URL がそのまま埋まっていることが判明したため、
ピュア httpx でフェッチ → 正規表現で取り出す方式に置き換えた。

フロー:
    1. ``https://www.dmm.co.jp/litevideo/-/part/=/cid=<cid>/size=720_480/affi_id=<aid>/``
       を fetch
    2. レスポンス HTML から
       ``iframe src="https://www.dmm.co.jp/service/digitalapi/..."``
       を抽出
    3. iframe URL を fetch
    4. ``var args = ({...})`` の {...} を JSON としてパース
    5. ``args["src"]`` を取り出し ``\/`` をアンエスケープ、``//`` で始まれば
       ``https:`` を前置

ResolveError サブクラスで HTTP ステータスコードへのマッピングを表現する:
    - ResolveNotFound  → HTTP 404 (iframe や args が見つからない)
    - ResolveTimeout   → HTTP 504 (httpx タイムアウト)
    - ResolveUpstream  → HTTP 502 (DMM 側のエラー / リダイレクト等)

注意:
    - DMM は海外 IP に対して `not-available-in-your-region` にリダイレクトする。
      日本 IP の環境で実行すること。
    - 年齢確認 Cookie (`age_check_done=1`, `ckcy=2`) が必須。
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 例外クラス
# ---------------------------------------------------------------------------


class ResolveError(Exception):
    """resolver 共通の基底例外。"""


class ResolveNotFound(ResolveError):
    """litevideo / iframe ページから MP4 URL が抽出できなかった。"""


class ResolveTimeout(ResolveError):
    """httpx リクエストがタイムアウトした。"""


class ResolveUpstream(ResolveError):
    """DMM 側のエラー (リダイレクト・地域制限・5xx 等)。"""


# ---------------------------------------------------------------------------
# 結果データクラス
# ---------------------------------------------------------------------------


@dataclass
class ResolveResult:
    content_id: str
    mp4_url: str


# ---------------------------------------------------------------------------
# 定数 / 正規表現
# ---------------------------------------------------------------------------


_DEFAULT_HEADERS = {
    "Cookie": "age_check_done=1; ckcy=2",
    "Accept-Language": "ja-JP,ja;q=0.9",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
}

# litevideo ページに埋まっている iframe タグ。digitalapi 配下の URL のみを拾う。
_IFRAME_RE = re.compile(
    r'iframe\s+src="(https://www\.dmm\.co\.jp/service/digitalapi[^"]+)"'
)

# html5_player ページの `var args = { ... };` を非貪欲に拾う。
# DMM HTML は実測で 1 行記述だが、念のため DOTALL で改行も許容する。
_ARGS_RE = re.compile(r"var\s+args\s*=\s*(\{.*?\})\s*;", re.DOTALL)


# ---------------------------------------------------------------------------
# 抽出ロジック
# ---------------------------------------------------------------------------


def _parse_iframe_url(html: str) -> str:
    m = _IFRAME_RE.search(html)
    if not m:
        raise ResolveNotFound("digitalapi iframe src not found in litevideo page")
    return m.group(1)


def _parse_mp4_src(html: str) -> str:
    m = _ARGS_RE.search(html)
    if not m:
        raise ResolveNotFound("'var args = {...}' not found in html5_player page")
    try:
        args = json.loads(m.group(1))
    except json.JSONDecodeError as e:
        raise ResolveUpstream(f"failed to JSON-parse args: {e}") from e

    src = args.get("src")
    if not isinstance(src, str) or not src:
        raise ResolveNotFound(f"args.src missing or empty: {args!r}")

    # JSON 内の \/ をアンエスケープ (json.loads 後にも残るケースがある)
    src = src.replace("\\/", "/")
    if src.startswith("//"):
        src = "https:" + src
    return src


async def extract_mp4_url(
    content_id: str,
    affiliate_id: str,
    *,
    timeout_s: float = 10.0,
    client: httpx.AsyncClient | None = None,
) -> ResolveResult:
    """1 つの content_id について MP4 URL を抽出する。

    Args:
        content_id: DMM コンテンツ ID (例: ``1sun00052a``)。
        affiliate_id: DMM アフィリエイト ID。
        timeout_s: 各 HTTP リクエストのタイムアウト (秒)。
        client: 既存の httpx.AsyncClient を再利用したい場合に渡す。
            None の場合は内部で新しく開いて閉じる。

    Returns:
        ResolveResult(content_id, mp4_url)

    Raises:
        ResolveTimeout: HTTP リクエストがタイムアウト。
        ResolveUpstream: DMM 側のエラー (リダイレクト・地域制限・JSON 解析失敗等)。
        ResolveNotFound: iframe / args が見つからない or src が空。
    """
    litevideo_url = (
        f"https://www.dmm.co.jp/litevideo/-/part/=/cid={content_id}"
        f"/size=720_480/affi_id={affiliate_id}/"
    )

    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=timeout_s, headers=_DEFAULT_HEADERS)

    try:
        try:
            r1 = await client.get(litevideo_url, headers=_DEFAULT_HEADERS)
        except httpx.TimeoutException as e:
            raise ResolveTimeout(f"litevideo fetch timed out: {e}") from e
        except httpx.HTTPError as e:
            raise ResolveUpstream(f"litevideo fetch failed: {e}") from e

        # 地域制限リダイレクトの検知。
        # httpx は follow_redirects=False がデフォルトだが、念のため両ケース対応。
        final_url = str(r1.url)
        if "not-available-in-your-region" in final_url:
            raise ResolveUpstream(
                f"DMM region block detected (url={final_url}). "
                "Resolver must run from a Japan IP."
            )
        if r1.status_code >= 400:
            raise ResolveUpstream(
                f"litevideo returned HTTP {r1.status_code} for cid={content_id}"
            )

        iframe_url = _parse_iframe_url(r1.text)

        try:
            r2 = await client.get(iframe_url, headers=_DEFAULT_HEADERS)
        except httpx.TimeoutException as e:
            raise ResolveTimeout(f"html5_player fetch timed out: {e}") from e
        except httpx.HTTPError as e:
            raise ResolveUpstream(f"html5_player fetch failed: {e}") from e

        if r2.status_code >= 400:
            raise ResolveUpstream(
                f"html5_player returned HTTP {r2.status_code} for cid={content_id}"
            )

        mp4_url = _parse_mp4_src(r2.text)
        return ResolveResult(content_id=content_id, mp4_url=mp4_url)
    finally:
        if owns_client:
            await client.aclose()
