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
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Final

import httpx
from fastapi import HTTPException, Request

from app.core.cache import get_redis
from app.core.rate_limit import SlidingWindowRateLimiter, get_resolve_rate_limiter
from app.resolver.extractor import (
    ResolveNotFound,
    ResolveTimeout,
    ResolveUpstream,
    extract_mp4_url,
)


@dataclass(frozen=True)
class ResolvedMp4:
    """resolver_client が返す MP4 URL のセット。

    `mp4_url` は呼び出し側の互換性 (既存の高画質寄りの 1 本) を保つフィールド。
    `low_mp4_url` / `high_mp4_url` は低画質ファースト戦略用の 2 候補で、
    どちらも `mp4_url` と同じ URL になることがある (single-bitrate)。
    """

    mp4_url: str
    low_mp4_url: str | None = None
    high_mp4_url: str | None = None


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

_inflight: dict[str, asyncio.Future[ResolvedMp4]] = {}
_inflight_lock = asyncio.Lock()
# キャッシュは低/高/primary の 3 URL をまとめてストアする。期限切れで丸ごと無効。
_success_cache: dict[str, tuple[ResolvedMp4, float]] = {}

# Redis キャッシュキーの prefix。複数アプリで Redis を共有しても衝突しない形にする。
_REDIS_KEY_PREFIX: Final[str] = "resolver:mp4:"


def _redis_key(content_id: str) -> str:
    return f"{_REDIS_KEY_PREFIX}{content_id}"


def _get_cached_inprocess(content_id: str) -> ResolvedMp4 | None:
    entry = _success_cache.get(content_id)
    if entry is None:
        return None
    resolved, expires_at = entry
    if time.monotonic() >= expires_at:
        _success_cache.pop(content_id, None)
        return None
    return resolved


def _put_cached_inprocess(content_id: str, resolved: ResolvedMp4) -> None:
    _success_cache[content_id] = (resolved, time.monotonic() + _SUCCESS_CACHE_TTL_S)


async def _get_cached_redis(content_id: str) -> ResolvedMp4 | None:
    """Redis から成功キャッシュを取得。Redis 未設定・例外なら None。

    Redis を共有していれば、複数 API インスタンス間で MP4 URL を共有できる。
    Redis ライブラリ未インストールや接続失敗時は in-process フォールバックに任せる。
    """
    redis = get_redis()
    if redis is None:
        return None
    try:
        raw = await redis.get(_redis_key(content_id))
    except Exception:  # noqa: BLE001
        # Redis が落ちていてもアプリ全体は止めない。in-process / 再抽出に倒す。
        logger.warning("redis get failed for %s", content_id, exc_info=True)
        return None
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return ResolvedMp4(
            mp4_url=data["mp4_url"],
            low_mp4_url=data.get("low_mp4_url"),
            high_mp4_url=data.get("high_mp4_url"),
        )
    except (KeyError, ValueError, TypeError):
        # 不正な値は無視して再抽出に倒す
        return None


async def _put_cached_redis(content_id: str, resolved: ResolvedMp4) -> None:
    redis = get_redis()
    if redis is None:
        return
    payload = json.dumps(
        {
            "mp4_url": resolved.mp4_url,
            "low_mp4_url": resolved.low_mp4_url,
            "high_mp4_url": resolved.high_mp4_url,
        }
    )
    try:
        # TTL は in-process と揃える (秒単位)
        await redis.set(
            _redis_key(content_id),
            payload,
            ex=int(_SUCCESS_CACHE_TTL_S),
        )
    except Exception:  # noqa: BLE001
        logger.warning("redis set failed for %s", content_id, exc_info=True)


async def _get_cached(content_id: str) -> ResolvedMp4 | None:
    """成功キャッシュを Redis → in-process の順で参照する。

    Redis が無効/失敗でも in-process LRU に倒れるので可用性は維持される。
    """
    # 1) Redis (共有キャッシュ)
    cached = await _get_cached_redis(content_id)
    if cached is not None:
        # Redis にヒットしたら in-process にも書いて以降の高速 path に乗せる
        _put_cached_inprocess(content_id, cached)
        return cached
    # 2) in-process フォールバック
    return _get_cached_inprocess(content_id)


async def _put_cached(content_id: str, resolved: ResolvedMp4) -> None:
    _put_cached_inprocess(content_id, resolved)
    await _put_cached_redis(content_id, resolved)


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


# HTTP/2 は h2 パッケージが入っている環境でのみ有効化する。
# DMM (www.dmm.co.jp) は HTTP/2 対応のため、有効化できると litevideo →
# html5_player の 2 リクエストを 1 本の TCP/TLS 接続上で多重化でき、
# 抽出レイテンシをわずかに削減できる。h2 が未インストールの環境では
# httpx.AsyncClient(http2=True) が ImportError を投げるため、事前に検出して
# False にフォールバックする (ローカル/テスト環境で h2 が未導入でも壊さない)。
try:  # pragma: no cover - import 可否は環境依存
    import h2  # type: ignore[import-not-found]  # noqa: F401

    _HTTP2_AVAILABLE = True
except ImportError:  # pragma: no cover
    _HTTP2_AVAILABLE = False


def _new_shared_client() -> httpx.AsyncClient:
    timeout_s = _get_timeout_s()
    return httpx.AsyncClient(
        timeout=timeout_s,
        limits=_HTTPX_LIMITS,
        http2=_HTTP2_AVAILABLE,
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
async def resolve_mp4(
    content_id: str,
    *,
    bypass_cache: bool = False,
    request: Request | None = None,
    limiter: SlidingWindowRateLimiter | None = None,
) -> ResolvedMp4:
    """DMM サンプル動画 MP4 URL を解決し、low/high 候補を含む結果を返す。

    `resolve_mp4_url` の後継。既存呼び出し元は `.mp4_url` プロパティ経由で
    既存挙動と互換のまま使える。低画質ファースト戦略を取りたい呼び出し元
    (web フロント / endpoint) は `.low_mp4_url` / `.high_mp4_url` を併用する。

    Rate limit (新設計):
        ``request`` (+任意で ``limiter``) を渡すと、本当に DMM へ外部リクエスト
        を投げる owner だけが IP 単位のレートリミットを消費する。
        in-flight デデュープでタダ乗りした waiter や、短期成功キャッシュ
        ヒットしたリクエストはリミッタを呼ばないため、フロントの prefetch +
        warm の同時バーストが overlap した状況でも 429 になりにくい。

        ``request`` を渡さなかった場合 (jobs / 内部ツール経由) はリミッタを
        スキップする。

    Args:
        content_id: DMM コンテンツ ID。
        bypass_cache: True なら短期成功キャッシュをスキップ。
            in-flight デデュープは bypass_cache=True でも有効。
        request: 呼び出し元の FastAPI Request。レート制限の IP 抽出に使う。
            None ならレート制限は走らない。
        limiter: 注入用フック (主にテスト)。None ならモジュール既定の
            ``get_resolve_rate_limiter()`` を使う。

    Returns:
        ResolvedMp4(mp4_url, low_mp4_url, high_mp4_url)。
        low/high が同じ URL になることもある (single-bitrate / 直リンクフォールバック)。

    Raises:
        HTTPException(429): owner がレート制限上限に到達。
        ResolverConfigError: DMM_AFFILIATE_ID 未設定。
        ResolverNotFound:    iframe / args が見つからない。
        ResolverUpstreamError: DMM 側のエラー。
        ResolverTimeout:     HTTP タイムアウト。
    """
    if not bypass_cache:
        cached = await _get_cached(content_id)
        if cached is not None:
            return cached

    # in-flight デデュープ
    async with _inflight_lock:
        existing = _inflight.get(content_id)
        if existing is not None:
            future: asyncio.Future[ResolvedMp4] = existing
            owner = False
        else:
            loop = asyncio.get_running_loop()
            future = loop.create_future()
            _inflight[content_id] = future
            owner = True

    if not owner:
        # 既に別リクエストが DMM を叩いている → タダ乗り。レート制限は消費しない。
        return await future

    # owner だけが実 DMM 外部リクエストを担う。ここで IP 単位レートリミットを
    # 適用する。check() は HTTPException(429) を投げるため、その前に in-flight
    # owner 状態を解放してから raise する。
    if request is not None:
        active_limiter = limiter or get_resolve_rate_limiter()
        try:
            active_limiter.check(request)
        except HTTPException:
            async with _inflight_lock:
                _inflight.pop(content_id, None)
            if not future.done():
                future.cancel()
            raise

    try:
        resolved = await _do_resolve(content_id)
    except BaseException as e:
        async with _inflight_lock:
            _inflight.pop(content_id, None)
        if not future.done():
            future.set_exception(e)
        future.exception()
        raise
    else:
        await _put_cached(content_id, resolved)
        async with _inflight_lock:
            _inflight.pop(content_id, None)
        if not future.done():
            future.set_result(resolved)
        return resolved


async def resolve_mp4_url(content_id: str, *, bypass_cache: bool = False) -> str:
    """既存呼び出し元向けの互換ラッパ。`resolve_mp4(...).mp4_url` を返す。

    新規呼び出し元は `resolve_mp4` を使うこと (low/high を取り出すため)。
    内部ツール / jobs から呼ぶことを想定しているため、レート制限はスキップする
    (`request` を渡さない)。
    """
    resolved = await resolve_mp4(content_id, bypass_cache=bypass_cache)
    return resolved.mp4_url


async def _do_resolve(content_id: str) -> ResolvedMp4:
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

    return ResolvedMp4(
        mp4_url=result.mp4_url,
        low_mp4_url=result.low_mp4_url,
        high_mp4_url=result.high_mp4_url,
    )


# ─────────────────────────────────────────────
# force=true 連打抑制 (retry storm guard)
# ─────────────────────────────────────────────
# /movies/{slug}/resolve-mp4?force=true は web 側の <video> エラーリトライで
# 呼ばれる想定だが、不具合や悪意のあるクライアントが繰り返し force=true を
# 投げると、DMM への httpx 呼び出しが連続発生してしまう。
# in-process に「直近 force=true 抽出時刻」を保持し、`_FORCE_RETRY_MIN_INTERVAL_S`
# 以内の force=true は強制 retry をスキップしてキャッシュ値を返す。
# レートリミッタとは別のレイヤ (個別 content_id 単位) で動く軽量ガード。
_FORCE_RETRY_MIN_INTERVAL_S: Final[float] = 5.0
_last_force_retry_at: dict[str, float] = {}


def should_throttle_force_retry(content_id: str) -> bool:
    """直近に force=true で再抽出したばかりの content_id なら True を返す。

    True のときは呼び出し側で `bypass_cache=False` で呼ぶことを推奨する。
    in-process なので複数インスタンス間では共有されないが、単一インスタンスでの
    リトライ storm 防止には十分に効く。
    """
    now = time.monotonic()
    last = _last_force_retry_at.get(content_id)
    if last is not None and now - last < _FORCE_RETRY_MIN_INTERVAL_S:
        return True
    return False


def mark_force_retry(content_id: str) -> None:
    """force=true で抽出を試みたタイミングを記録する。

    in-process テーブルの肥大を避けるため、エントリ数が一定を超えたら最古を捨てる。
    """
    now = time.monotonic()
    _last_force_retry_at[content_id] = now
    if len(_last_force_retry_at) > 4096:
        # 半分残して古いほうを捨てる (簡易 sweep)
        cutoff = now - _FORCE_RETRY_MIN_INTERVAL_S
        stale = [k for k, v in _last_force_retry_at.items() if v < cutoff]
        for k in stale:
            _last_force_retry_at.pop(k, None)


def _reset_state_for_tests() -> None:
    """テスト用: in-flight テーブルと短期キャッシュを空にする。"""
    _inflight.clear()
    _success_cache.clear()
    _last_force_retry_at.clear()


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
