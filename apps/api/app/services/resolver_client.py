"""Resolver サービス (Xserver VPS 上の apps/resolver) を呼ぶ HTTP クライアント。

resolver は DMM のサンプル動画ページから MP4 URL を Playwright で抽出する
別ホストの FastAPI サービス。本モジュールは httpx で薄く包んで、

  - ベース URL / API キー / タイムアウトを Settings から読む
  - 認証ヘッダを付ける
  - resolver 側のステータスコード (404/502/504) を例外クラスに変換する

ことだけを行う。リトライや DB キャッシュは呼び出し側 (endpoint) の責務。
"""
from __future__ import annotations

import logging
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


def _build_url(base: str, path: str) -> str:
    """末尾スラッシュの有無を吸収して URL を組み立てる。"""
    return f"{base.rstrip('/')}{path}"


async def resolve_mp4_url(content_id: str) -> str:
    """resolver サービスを呼んで MP4 URL を取得する。

    Returns:
        cc3001.dmm.co.jp/pv/... 形式の MP4 URL。

    Raises:
        ResolverConfigError: 環境変数未設定。
        ResolverNotFound:    404 (作品が存在しない / 非公開)。
        ResolverUpstreamError: 502 (DMM 側エラー)。
        ResolverTimeout:     504 / クライアント側タイムアウト。
        ResolverUnavailable: それ以外の 5xx / ネットワーク障害 / 401。
    """
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
