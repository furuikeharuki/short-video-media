"""DMM サンプル動画 MP4 URL を解決するクライアント (in-process)。

以前は Xserver VPS 上の独立 resolver サービス (Playwright) を HTTP で
叩いていたが、DMM の html5_player ページが ``var args = {...}`` 形式で
MP4 URL をそのまま返してくれることが分かったため、ピュア httpx で
in-process に解決する実装に切り替えた (apps/resolver コンテナは廃止)。

互換性のため公開 API (関数名・例外クラス) は据え置き、movies endpoint
や jobs ジョブの呼び出し箇所をそのままにしてある。

提供する機能:
  - in-flight デデュープ + 短期成功キャッシュで同 content_id の重複抽出を抑える
  - extractor の例外を呼び出し側向けの例外クラスに変換する
  - DMM_AFFILIATE_ID 未設定なら ResolverConfigError
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Final

from app.resolver.extractor import (
    ResolveNotFound,
    ResolveTimeout,
    ResolveUpstream,
    extract_mp4_url,
)


logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────
# 例外
# ─────────────────────────────────────────────
class ResolverError(Exception):
    """Resolver 呼び出しに関する例外の基底クラス。"""


class ResolverConfigError(ResolverError):
    """DMM_AFFILIATE_ID が未設定 (500 にマップ)。"""


class ResolverNotFound(ResolverError):
    """MP4 URL がページから抽出できなかった (404 にマップ)。"""


class ResolverUpstreamError(ResolverError):
    """DMM 側のエラー / レスポンス異常 (502 にマップ)。"""


class ResolverTimeout(ResolverError):
    """HTTP タイムアウト (504 にマップ)。"""


class ResolverUnavailable(ResolverError):
    """ネットワーク到達不能等。現実装ではほぼ発生しないが互換のため残す。"""


# ─────────────────────────────────────────────
# キャッシュ / デデュープ
# ─────────────────────────────────────────────
# 同一 content_id の再抽出は ~1-2 秒だが、連打を抑えるため短期キャッシュを残す。
# DMM 側のトークンは 32 日以上有効なため 5 分の TTL は安全マージンとして十分。
# 1 ユーザー 1 セッション内ではほぼキャッシュヒットさせて DMM へのアクセス数と
# httpx ラウンドトリップを大幅に減らす。
_SUCCESS_CACHE_TTL_S: Final[float] = 300.0

_inflight: dict[str, asyncio.Future[str]] = {}
_inflight_lock = asyncio.Lock()
_success_cache: dict[str, tuple[str, float]] = {}


def _get_cached(content_id: str) -> str | None:
    entry = _success_cache.get(content_id)
    if entry is None:
        return None
    mp4_url, expires_at = entry
    if time.monotonic() >= expires_at:
        _success_cache.pop(content_id, None)
        return None
    return mp4_url


def _put_cached(content_id: str, mp4_url: str) -> None:
    _success_cache[content_id] = (mp4_url, time.monotonic() + _SUCCESS_CACHE_TTL_S)


# ─────────────────────────────────────────────
# 設定
# ─────────────────────────────────────────────
# extractor 単体のタイムアウト (秒)。litevideo + html5_player の 2 リクエスト
# 分なので、リクエスト全体としては ~2x まで。
_DEFAULT_TIMEOUT_S: Final[float] = 10.0


def _get_affiliate_id() -> str:
    """DMM アフィリエイト ID を環境変数から取得。"""
    return os.environ.get("DMM_AFFILIATE_ID", "").strip()


def _get_timeout_s() -> float:
    """extractor のタイムアウトを取得。"""
    raw = os.environ.get("RESOLVER_TIMEOUT_MS", "").strip()
    if not raw:
        return _DEFAULT_TIMEOUT_S
    try:
        ms = int(raw)
    except ValueError:
        return _DEFAULT_TIMEOUT_S
    return max(1.0, ms / 1000.0)


# ─────────────────────────────────────────────
# 公開 API
# ─────────────────────────────────────────────
async def resolve_mp4_url(content_id: str, *, bypass_cache: bool = False) -> str:
    """DMM サンプル動画 MP4 URL を解決する。

    Args:
        content_id: DMM コンテンツ ID。
        bypass_cache: True なら短期成功キャッシュをスキップ。
            in-flight デデュープは bypass_cache=True でも有効。

    Returns:
        cc3001.dmm.co.jp/pv/... 形式の MP4 URL。

    Raises:
        ResolverConfigError: DMM_AFFILIATE_ID 未設定。
        ResolverNotFound:    iframe / args が見つからない。
        ResolverUpstreamError: DMM 側のエラー。
        ResolverTimeout:     HTTP タイムアウト。
    """
    if not bypass_cache:
        cached = _get_cached(content_id)
        if cached is not None:
            return cached

    # in-flight デデュープ
    async with _inflight_lock:
        existing = _inflight.get(content_id)
        if existing is not None:
            future: asyncio.Future[str] = existing
            owner = False
        else:
            loop = asyncio.get_running_loop()
            future = loop.create_future()
            _inflight[content_id] = future
            owner = True

    if not owner:
        return await future

    try:
        mp4_url = await _do_resolve(content_id)
    except BaseException as e:
        async with _inflight_lock:
            _inflight.pop(content_id, None)
        if not future.done():
            future.set_exception(e)
        future.exception()
        raise
    else:
        _put_cached(content_id, mp4_url)
        async with _inflight_lock:
            _inflight.pop(content_id, None)
        if not future.done():
            future.set_result(mp4_url)
        return mp4_url


async def _do_resolve(content_id: str) -> str:
    affiliate_id = _get_affiliate_id()
    if not affiliate_id:
        raise ResolverConfigError("DMM_AFFILIATE_ID is not configured")

    timeout_s = _get_timeout_s()

    try:
        result = await extract_mp4_url(
            content_id=content_id,
            affiliate_id=affiliate_id,
            timeout_s=timeout_s,
        )
    except ResolveNotFound as e:
        raise ResolverNotFound(str(e)) from e
    except ResolveTimeout as e:
        logger.warning("resolver timeout: content_id=%s err=%s", content_id, e)
        raise ResolverTimeout(str(e)) from e
    except ResolveUpstream as e:
        logger.warning("resolver upstream: content_id=%s err=%s", content_id, e)
        raise ResolverUpstreamError(str(e)) from e

    return result.mp4_url


def _reset_state_for_tests() -> None:
    """テスト用: in-flight テーブルと短期キャッシュを空にする。"""
    _inflight.clear()
    _success_cache.clear()
