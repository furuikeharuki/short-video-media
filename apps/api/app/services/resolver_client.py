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

import httpx

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
# DMM 側のトークンは 32 日以上有効なため 1 時間の TTL は安全マージンとして十分。
# 1 ユーザー 1 セッション内ではほぼキャッシュヒットさせて DMM へのアクセス数と
# httpx ラウンドトリップを大幅に減らす。
# v5.x: prefetch +5 化で同一 content_id への問い合わせ頻度が増えたため、
# 300s → 3600s に拡大して DMM への実アクセスをさらに削減する。
_SUCCESS_CACHE_TTL_S: Final[float] = 3600.0

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
# 共有 httpx.AsyncClient (keep-alive)
# ─────────────────────────────────────────────
# DMM (www.dmm.co.jp) への接続は TLS ハンドシェイクのコストが高い。
# 抽出ごとに AsyncClient を作って閉じると毎回 TCP+TLS が立ち上がり、
# 1 リクエストあたり数百 ms 余計にかかる。
# プロセスで 1 本だけ AsyncClient を保持し、コネクションプールを再利用する
# ことで DMM 側との keep-alive を維持し、抽出レイテンシと CPU を削減する。
#
# ライフサイクル:
#   - app.main の lifespan で startup_resolver_http_client() を呼んで生成、
#     終了時に shutdown_resolver_http_client() で aclose() する。
#   - lifespan が走らない経路 (一部のテスト等) でも `_get_shared_client()`
#     が現在の event loop に紐づいた client を遅延生成するためフォールバックする。
#     loop が変わったら (例: 別テスト) 自動で作り直す。
_HTTPX_LIMITS: Final[httpx.Limits] = httpx.Limits(
    max_connections=32,
    max_keepalive_connections=16,
    keepalive_expiry=30.0,
)
_shared_client: httpx.AsyncClient | None = None
_shared_client_loop: asyncio.AbstractEventLoop | None = None
_shared_client_lock = asyncio.Lock()


def _new_shared_client() -> httpx.AsyncClient:
    timeout_s = _get_timeout_s()
    return httpx.AsyncClient(
        timeout=timeout_s,
        limits=_HTTPX_LIMITS,
    )


async def startup_resolver_http_client() -> None:
    """FastAPI lifespan startup から呼ぶ。共有 AsyncClient を初期化する。"""
    global _shared_client, _shared_client_loop
    async with _shared_client_lock:
        if _shared_client is not None:
            return
        _shared_client = _new_shared_client()
        _shared_client_loop = asyncio.get_running_loop()


async def shutdown_resolver_http_client() -> None:
    """FastAPI lifespan shutdown から呼ぶ。共有 AsyncClient を閉じる。"""
    global _shared_client, _shared_client_loop
    async with _shared_client_lock:
        client = _shared_client
        _shared_client = None
        _shared_client_loop = None
    if client is not None:
        try:
            await client.aclose()
        except Exception:  # noqa: BLE001
            logger.warning("failed to close shared resolver http client", exc_info=True)


async def _get_shared_client() -> httpx.AsyncClient:
    """共有 AsyncClient を返す。未初期化なら現在の loop で作る。

    別 event loop で作られたものが残っていたら作り直す
    (テスト内で loop が複数立ち上がるケースに備える)。
    """
    global _shared_client, _shared_client_loop
    loop = asyncio.get_running_loop()
    if _shared_client is None or _shared_client_loop is not loop:
        async with _shared_client_lock:
            if _shared_client is None or _shared_client_loop is not loop:
                old = _shared_client
                _shared_client = _new_shared_client()
                _shared_client_loop = loop
                if old is not None:
                    try:
                        await old.aclose()
                    except Exception:  # noqa: BLE001
                        pass
    return _shared_client


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
    client = await _get_shared_client()

    try:
        result = await extract_mp4_url(
            content_id=content_id,
            affiliate_id=affiliate_id,
            timeout_s=timeout_s,
            client=client,
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


async def _reset_shared_client_for_tests() -> None:
    """テスト用: 共有 httpx.AsyncClient を閉じて未初期化状態に戻す。"""
    global _shared_client, _shared_client_loop
    async with _shared_client_lock:
        client = _shared_client
        _shared_client = None
        _shared_client_loop = None
    if client is not None:
        try:
            await client.aclose()
        except Exception:  # noqa: BLE001
            pass
