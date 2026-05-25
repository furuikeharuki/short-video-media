r"""DMM litevideo iframe から MP4 直リンク URL を抽出するコアロジック。

以前は Playwright で iframe ページを開いて <video> 要素や network から
取得していたが、DMM 側の html5_player ページが返す HTML に
``var args = {...}`` の形で MP4 URL がそのまま埋まっていることが判明したため、
ピュア httpx でフェッチ → JS オブジェクトを抽出する方式に置き換えた。

フロー:
    1. ``https://www.dmm.co.jp/litevideo/-/part/=/cid=<cid>/size=720_480/affi_id=<aid>/``
       を fetch
    2. レスポンス HTML から
       ``iframe src="https://www.dmm.co.jp/service/digitalapi/..."``
       を抽出
    3. iframe URL を fetch
    4. ``args = { ... }`` の中身を JSON としてパース (ネストした
       ``bitrates: [{...}]`` や ``controls: {...}`` を含むためバランス括弧で抽出)
    5. ``args["src"]`` を取り出し ``\/`` をアンエスケープ、``//`` で始まれば
       ``https:`` を前置
    6. 上記がいずれも失敗したら HTML 全体から ``cc3001.dmm.co.jp/...mp4``
       を直接拾うフォールバックを試す

ResolveError サブクラスで HTTP ステータスコードへのマッピングを表現する:
    - ResolveNotFound  → HTTP 404 (iframe / args / mp4 のいずれも見つからない)
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
# クォートは ", ', 無しの 3 パターンを許容。
_IFRAME_RE = re.compile(
    r"""iframe[^>]*?\s+src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))""",
    re.IGNORECASE,
)
_DIGITALAPI_HOST_PREFIX = "https://www.dmm.co.jp/service/digitalapi"

# `args = {` の開始位置を探す。`var args =` / `window.args =` / `args =` のいずれにも対応。
_ARGS_START_RE = re.compile(
    r"(?:\bvar\s+|\bwindow\s*\.\s*|\b)args\s*=\s*\{",
    re.IGNORECASE,
)

# html5_player の直接 MP4 フォールバック。
# `\/` エスケープ・素のスラッシュ・protocol-relative の 3 パターンを許容。
_DIRECT_MP4_RE = re.compile(
    r"""(?xi)
    (?:https?:)?           # 任意の https: / http:
    (?:\\/\\/|//)          # `\/\/` または `//`
    cc3001\.dmm\.co\.jp    # CDN ホスト
    (?:\\/|/)              # 続くスラッシュもエスケープ許容
    [^"'\s<>]+?            # パス本体
    \.mp4                  # 拡張子
    (?:\?[^"'\s<>]*)?      # 任意クエリ
    """
)


# ---------------------------------------------------------------------------
# 抽出ロジック
# ---------------------------------------------------------------------------


def _parse_iframe_url(html: str) -> str:
    """litevideo HTML から digitalapi 配下の iframe src を 1 つだけ拾う。"""
    for m in _IFRAME_RE.finditer(html):
        src = m.group(1) or m.group(2) or m.group(3) or ""
        if src.startswith("//"):
            src = "https:" + src
        if src.startswith(_DIGITALAPI_HOST_PREFIX):
            return src
    raise ResolveNotFound("digitalapi iframe src not found in litevideo page")


def _extract_args_object(html: str) -> str | None:
    """``args = { ... }`` のオブジェクト文字列をバランス括弧で抜き出す。

    JSON 文字列内の `{` `}` は無視するため、" / ' / バックスラッシュエスケープを
    state machine で追跡する。マッチ位置が見つからなければ None。
    """
    m = _ARGS_START_RE.search(html)
    if m is None:
        return None
    # `_ARGS_START_RE` は最後の `{` まで含むので、その位置からスキャン開始。
    start = m.end() - 1
    depth = 0
    in_str: str | None = None
    escape = False
    i = start
    n = len(html)
    while i < n:
        ch = html[i]
        if in_str is not None:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == in_str:
                in_str = None
        else:
            if ch == '"' or ch == "'":
                in_str = ch
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return html[start : i + 1]
        i += 1
    return None


def _normalize_mp4_url(src: str) -> str:
    """`\\/` をアンエスケープし、protocol-relative なら ``https:`` を前置する。"""
    src = src.replace("\\/", "/")
    if src.startswith("//"):
        src = "https:" + src
    return src


def _parse_mp4_src(html: str) -> str:
    """html5_player ページから MP4 URL を抜き出す。

    1) ``args = {...}`` を balanced-brace で抜き JSON.parse → ``args.src``
    2) 1) が失敗した場合は HTML 全体から cc3001 配下の MP4 URL を直接拾う

    どちらも見つからなければ ResolveNotFound、
    args オブジェクトはあるが JSON として壊れている場合は ResolveUpstream。
    """
    args_str = _extract_args_object(html)
    parse_error: Exception | None = None
    if args_str is not None:
        try:
            args = json.loads(args_str)
        except json.JSONDecodeError as e:
            # JSON パース失敗を覚えておくが、フォールバックで救えるかも知れない
            # ので直ちには raise しない。
            parse_error = e
            args = None

        if isinstance(args, dict):
            src = args.get("src")
            if isinstance(src, str) and src:
                return _normalize_mp4_url(src)
            # src が無い／空の場合: フォールバックを試した上で最終的に NotFound。
            fallback = _direct_mp4_fallback(html)
            if fallback is not None:
                logger.info(
                    "args.src missing; recovered MP4 via direct fallback (cid hint=%s)",
                    args.get("cid") or args.get("title") or "?",
                )
                return fallback
            raise ResolveNotFound(f"args.src missing or empty: {args!r}")

    # ここに来るのは: (a) args オブジェクトを見つけられなかった、または
    # (b) 見つけたが JSON として壊れていた、のどちらか。
    fallback = _direct_mp4_fallback(html)
    if fallback is not None:
        if parse_error is not None:
            logger.warning(
                "args JSON parse failed (%s); recovered via direct mp4 fallback",
                parse_error,
            )
        return fallback

    if parse_error is not None:
        raise ResolveUpstream(f"failed to JSON-parse args: {parse_error}") from parse_error
    raise ResolveNotFound("'args = {...}' / direct mp4 url not found in html5_player page")


def _direct_mp4_fallback(html: str) -> str | None:
    """HTML 全体から cc3001.dmm.co.jp 配下の MP4 URL を直接拾う。

    優先度:
        1. `_mhb_w.mp4` (DMM の高ビットレート preview)
        2. その他、最初に見つかった MP4 URL
    """
    matches = [m.group(0) for m in _DIRECT_MP4_RE.finditer(html)]
    if not matches:
        return None
    # `_mhb_w.mp4` を含むものを優先 (DMM の高画質サンプル)
    preferred = [u for u in matches if "mhb_w.mp4" in u]
    chosen = preferred[0] if preferred else matches[0]
    return _normalize_mp4_url(chosen)


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
