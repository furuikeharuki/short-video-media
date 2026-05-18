"""Resolver サービス (Xserver VPS 上の apps/resolver) を呼ぶ HTTP クライアント。

resolver は DMM のサンプル動画ページから MP4 URL を Playwright で抽出する
別ホストの FastAPI サービス。本モジュールは httpx で薄く包んで、

  - ベース URL / API キー / タイムアウトを Settings から読む
  - 認証ヘッダを付ける
  - resolver 側のステータスコード (404/502/504) を例外クラスに変換する
  - in-flight デデュープ + 短期成功キャッシュで同 content_id の重複呼びを抑える

ことを行う。DB キャッシュ (movies.sample_movie_url) や HTTP リトライは
呼び出し側 (endpoint) の責務。
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Final

import httpx

from app.core.config import settings


logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────
# 例外
# ─────────────────────────────────────────────
class ResolverError(Exception):
    """Resolver 呼び出しに関する例外の基底クラス。"""


class ResolverConfigError(ResolverError):
    """RESOLVER_BASE_URL / RESOLVER_API_KEY が未設定 (500 にマップ)。"""


class ResolverNotFound(ResolverError):
    """resolver が 404 を返した (content_id 該当なし、または非公開作品)。"""


class ResolverUpstreamError(ResolverError):
    """resolver が 502 を返した (DMM 側のエラー / レスポンス異常)。"""


class ResolverTimeout(ResolverError):
    """resolver が 504 を返した、もしくは HTTP レベルでタイムアウトした。"""


class ResolverUnavailable(ResolverError):
    """resolver サーバそのものに繋がらない / 5xx 系 (ネットワーク障害)。"""


# ─────────────────────────────────────────────
# クライアント
# ─────────────────────────────────────────────
_RESOLVE_PATH: Final[str] = "/resolve"

# 短期成功キャッシュの TTL。
# resolver が同じ content_id を Playwright で再抽出するのは 8 秒かかるため、
# その直後にもう一度叩かれたら同じ URL をそのまま返す。トークンは 32 日以上
# 有効なので 60 秒のキャッシュは十分安全。
_SUCCESS_CACHE_TTL_S: Final[float] = 60.0

# in-flight デデュープ用テーブル。content_id ごとに 1 つの Future を共有する。
# プロセスローカル (Railway は基本 1 インスタンスなので問題ない)。
_inflight: dict[str, asyncio.Future[str]] = {}
_inflight_lock = asyncio.Lock()

# 直近の成功結果キャッシュ。content_id -> (mp4_url, expires_at_monotonic)
_success_cache: dict[str, tuple[str, float]] = {}


def _build_url(base: str, path: str) -> str:
    """末尾スラッシュの有無を吸収して URL を組み立てる。"""
    return f"{base.rstrip('/')}{path}"


def _get_cached(content_id: str) -> str | None:
    """期限内の成功結果があれば返す。"""
    entry = _success_cache.get(content_id)
    if entry is None:
        return None
    mp4_url, expires_at = entry
    if time.monotonic() >= expires_at:
        # 期限切れは破棄
        _success_cache.pop(content_id, None)
        return None
    return mp4_url


def _put_cached(content_id: str, mp4_url: str) -> None:
    _success_cache[content_id] = (mp4_url, time.monotonic() + _SUCCESS_CACHE_TTL_S)


async def resolve_mp4_url(content_id: str, *, bypass_cache: bool = False) -> str:
    """resolver サービスを呼んで MP4 URL を取得する。

    同じ content_id への in-flight リクエストは 1 回にまとめる。
    bypass_cache=False のときは 60 秒以内の成功結果を即返す。

    Args:
        content_id: DMM コンテンツ ID。
        bypass_cache: True なら短期成功キャッシュをスキップして必ず resolver を叩く。
            web 側の force リトライ (DB キャッシュも信頼しない) のとき使う。
            注意: in-flight デデュープは bypass_cache=True でも有効。
                  同じ瞬間に同じ content_id が複数回投げられたら 1 回に集約する。

    Returns:
        cc3001.dmm.co.jp/pv/... 形式の MP4 URL。

    Raises:
        ResolverConfigError: 環境変数未設定。
        ResolverNotFound:    404 (作品が存在しない / 非公開)。
        ResolverUpstreamError: 502 (DMM 側エラー)。
        ResolverTimeout:     504 / クライアント側タイムアウト。
        ResolverUnavailable: それ以外の 5xx / ネットワーク障害 / 401。
    """
    # 短期キャッシュをまずチェック (force リトライでなければ)。
    if not bypass_cache:
        cached = _get_cached(content_id)
        if cached is not None:
            return cached

    # in-flight デデュープ。同じ content_id を既に走らせていれば、その結果を待つ。
    # asyncio.Lock の中で確認 → 作成することで取りこぼしを防ぐ。
    async with _inflight_lock:
        existing = _inflight.get(content_id)
        if existing is not None:
            # 既に走っている呼び出しを共有
            future: asyncio.Future[str] = existing
            owner = False
        else:
            loop = asyncio.get_running_loop()
            future = loop.create_future()
            _inflight[content_id] = future
            owner = True

    if not owner:
        # 別の呼び出しが走らせている。結果を待つだけ。
        # 例外も透過させる (await すれば再 raise される)。
        return await future

    # オーナー: 実際に resolver を叩く。
    try:
        mp4_url = await _do_resolve(content_id)
    except BaseException as e:
        # in-flight 待ちの全員に例外を伝播 → テーブルから外す。
        async with _inflight_lock:
            _inflight.pop(content_id, None)
        if not future.done():
            future.set_exception(e)
        # 誰も待っていない future の例外コンテキストを取り出すことで
        # "Future exception was never retrieved" 警告を抑える。
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
    """resolver に対して 1 回 HTTP リクエストを投げる (キャッシュ・デデュープなし)。"""
    base = settings.RESOLVER_BASE_URL.strip()
    key = settings.RESOLVER_API_KEY.strip()
    if not base or not key:
        raise ResolverConfigError(
            "RESOLVER_BASE_URL or RESOLVER_API_KEY is not configured"
        )

    url = _build_url(base, _RESOLVE_PATH)
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    payload = {"content_id": content_id}
    # ミリ秒 → 秒。httpx は秒単位の float を取る。
    timeout_s = max(1.0, settings.RESOLVER_TIMEOUT_MS / 1000.0)

    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.post(url, headers=headers, json=payload)
    except httpx.TimeoutException as e:
        logger.warning("resolver timeout: content_id=%s err=%s", content_id, e)
        raise ResolverTimeout(f"resolver timeout after {timeout_s}s") from e
    except httpx.HTTPError as e:
        # ネットワーク到達不能 (接続拒否、DNS エラー等)
        logger.warning(
            "resolver network error: content_id=%s err=%s", content_id, e
        )
        raise ResolverUnavailable(f"resolver unreachable: {e}") from e

    status_code = resp.status_code
    if status_code == 200:
        try:
            data = resp.json()
        except ValueError as e:
            raise ResolverUpstreamError(
                f"resolver returned non-JSON 200: {resp.text[:200]}"
            ) from e
        mp4_url = data.get("mp4_url")
        if not isinstance(mp4_url, str) or not mp4_url:
            raise ResolverUpstreamError(
                f"resolver 200 missing mp4_url: {data!r}"
            )
        return mp4_url

    # resolver 側で定義したエラーコードを透過。
    detail = _safe_detail(resp)
    if status_code == 404:
        raise ResolverNotFound(detail or "content not found")
    if status_code == 502:
        raise ResolverUpstreamError(detail or "upstream (DMM) error")
    if status_code == 504:
        raise ResolverTimeout(detail or "resolver gateway timeout")
    if status_code == 401:
        # キー設定ミス。運用者側の問題なので 5xx 扱い (透過させない)。
        logger.error("resolver auth failed: check RESOLVER_API_KEY")
        raise ResolverUnavailable("resolver authentication failed")

    # その他 (500/503 等) は一括して unavailable
    logger.warning(
        "resolver unexpected status: %s detail=%s", status_code, detail
    )
    raise ResolverUnavailable(
        f"resolver returned {status_code}: {detail or '(no detail)'}"
    )


def _safe_detail(resp: httpx.Response) -> str:
    """FastAPI のエラーレスポンス {detail: ...} から detail だけ取り出す。"""
    try:
        body = resp.json()
    except ValueError:
        return resp.text[:200]
    if isinstance(body, dict):
        detail = body.get("detail")
        if isinstance(detail, str):
            return detail
        return str(detail) if detail is not None else ""
    return str(body)[:200]


def _reset_state_for_tests() -> None:
    """テスト用: in-flight テーブルと短期キャッシュを空にする。"""
    _inflight.clear()
    _success_cache.clear()
