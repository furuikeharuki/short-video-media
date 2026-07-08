"""シンプルな in-memory レートリミッタ + 共通の client-IP 抽出ヘルパー。

GitHub Actions 等で複数インスタンスが動く本番では Redis ベースに置き換えるべきだが、
現状の Railway 1 インスタンス構成 + 軽量イベント計測の用途なら十分機能する。

使い方:
    from app.core.rate_limit import EventRateLimiter, get_event_rate_limiter

    @router.post("/events")
    async def create_event(
        request: Request,
        limiter: Annotated[EventRateLimiter, Depends(get_event_rate_limiter)],
    ):
        limiter.check(request)
        ...

メモリ管理:
    IP ごとに deque を保持するため、攻撃者が大量の異なる IP を送ると IP テーブル
    が肥大化する懸念がある。`check()` 内で空になった deque を削除し、さらに一定
    間隔で全体的に古い (= 直近 ``_window_sec`` 秒間アクセスのない) IP を一掃する
    ことで上限を抑える。
"""
from __future__ import annotations

import time
from collections import defaultdict, deque
from threading import Lock
from typing import Deque

from fastapi import HTTPException, Request, status

from app.core.config import settings


def client_ip(request: Request) -> str:
    """リバースプロキシ越しの「信頼できる」 client IP を返す。

    セキュリティ上の前提:
        X-Forwarded-For (XFF) の *左端* はクライアントが自由に詐称できる。
        素朴に左端を採用すると、攻撃者が毎回別の偽 IP を送るだけで per-IP
        レートリミットを丸ごと回避できてしまう。そこで「信頼できるリバース
        プロキシの段数」(settings.TRUSTED_PROXY_HOPS) を使い、XFF の *右側*
        (= 各信頼プロキシが追記した実 peer IP) から数えて該当位置を採用する。

    アルゴリズム:
        - hops <= 0: ヘッダを一切信用せず request.client.host を返す
          (プロキシ無しで直接公開する構成)。
        - hops >= 1: XFF を右から数えて hops 番目 (parts[-hops]) を返す。
          これは「最も外側の信頼プロキシが観測した接続元 IP」であり、
          その左側 (= クライアント自称部分) は無視されるので詐称できない。
        - XFF が期待する段数より短い / 存在しない場合は、信頼プロキシが
          セットする単値ヘッダ (x-real-ip / cf-connecting-ip) → 最後に
          request.client.host の順にフォールバックする (fail-closed)。
    """
    peer = request.client.host if request.client else "unknown"

    hops = settings.TRUSTED_PROXY_HOPS
    if hops < 0:
        hops = 0
    if hops == 0:
        # プロキシを信頼しない構成: 実 TCP peer のみを使う。
        return peer

    xff = request.headers.get("x-forwarded-for")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if len(parts) >= hops:
            # 右から hops 番目 = 最外側の信頼プロキシが観測した接続元。
            return parts[-hops]
        # XFF が期待段数より短い (構成ミス / プロキシがヘッダを削った等)。
        # 左端は詐称可能なので採用せず、下の単値ヘッダ / peer にフォールバック。

    # 信頼プロキシが上書きセットする単値ヘッダ。XFF が使えない時の保険。
    for header in ("x-real-ip", "cf-connecting-ip"):
        v = request.headers.get(header)
        if v:
            return v.split(",")[0].strip()
    return peer


class SlidingWindowRateLimiter:
    """IP ごとに 1 秒・1 分の sliding window でリクエスト数を制限する汎用クラス。

    EventRateLimiter は名前を保ったまま、これの薄いラッパーとして残す。
    sign-in や resolve-mp4 など他エンドポイント向けにはこのクラスを直接使う。
    """

    # 全体クリーンアップを走らせる check 回数の間隔
    _SWEEP_INTERVAL_CHECKS = 1024

    def __init__(
        self,
        per_second: int,
        per_minute: int,
        *,
        name: str = "rate_limit",
        window_sec: float = 60.0,
    ) -> None:
        self._per_second = per_second
        self._per_minute = per_minute
        self._name = name
        self._window_sec = window_sec
        # IP -> 過去 window_sec 秒以内のタイムスタンプ (epoch sec, float)
        self._hits: dict[str, Deque[float]] = defaultdict(deque)
        self._lock = Lock()
        self._check_count = 0

    def _client_ip(self, request: Request) -> str:
        return client_ip(request)

    def _sweep_locked(self, now: float) -> None:
        """ロック内から呼ばれる。古い / 空 IP バケットを削除して memory を解放する。"""
        stale: list[str] = []
        for ip, dq in self._hits.items():
            while dq and now - dq[0] > self._window_sec:
                dq.popleft()
            if not dq:
                stale.append(ip)
        for ip in stale:
            self._hits.pop(ip, None)

    def check(self, request: Request) -> None:
        now = time.monotonic()
        ip = self._client_ip(request)
        with self._lock:
            self._check_count += 1
            if self._check_count % self._SWEEP_INTERVAL_CHECKS == 0:
                # 定期的に全体クリーンアップ。攻撃 IP が大量に来ても上限を抑える。
                self._sweep_locked(now)

            dq = self._hits[ip]
            # window 外のタイムスタンプを破棄
            while dq and now - dq[0] > self._window_sec:
                dq.popleft()
            # 1 秒以内のヒット数
            recent_1s = sum(1 for t in dq if now - t <= 1.0)
            if recent_1s >= self._per_second:
                # 空になっていれば落とす (DoS で生成された empty bucket 対策)
                if not dq:
                    self._hits.pop(ip, None)
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=f"{self._name}: rate limit exceeded (per second)",
                )
            if len(dq) >= self._per_minute:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=f"{self._name}: rate limit exceeded (per minute)",
                )
            dq.append(now)
        return None

    # ------- testing helpers --------------------------------------------------
    def _bucket_count_for_tests(self) -> int:
        with self._lock:
            return len(self._hits)

    def _force_sweep_for_tests(self) -> None:
        with self._lock:
            self._sweep_locked(time.monotonic())

    def _reset_for_tests(self) -> None:
        with self._lock:
            self._hits.clear()
            self._check_count = 0


# 後方互換用エイリアス (events 系で使われている名前)
EventRateLimiter = SlidingWindowRateLimiter


_event_limiter = SlidingWindowRateLimiter(
    per_second=settings.EVENTS_RATE_LIMIT_PER_SECOND,
    per_minute=settings.EVENTS_RATE_LIMIT_PER_MINUTE,
    name="events",
)


def get_event_rate_limiter() -> SlidingWindowRateLimiter:
    return _event_limiter


# ----------------------------------------------------------------------------
# 認証 (sign-in) 用レートリミッタ
# ----------------------------------------------------------------------------
# 同一 IP からのサインインの暴力的な試行 (盗まれた exchange JWT の総当たり、
# 大量の新規ユーザー作成攻撃など) を抑制する。POST /auth/sign-in は内部で
# get_or_create を行うため、無制限に呼ばれると users テーブルが膨らむ。
# デフォルトは保守的に、1 秒あたり 5 回 / 1 分あたり 20 回。
_signin_limiter = SlidingWindowRateLimiter(
    per_second=getattr(settings, "SIGNIN_RATE_LIMIT_PER_SECOND", 5),
    per_minute=getattr(settings, "SIGNIN_RATE_LIMIT_PER_MINUTE", 20),
    name="signin",
)


def get_signin_rate_limiter() -> SlidingWindowRateLimiter:
    return _signin_limiter


# ----------------------------------------------------------------------------
# /feed 向けレートリミッタ
# ----------------------------------------------------------------------------
# 匿名でも叩ける重いエンドポイントなので、極端な連打を抑える。通常スクロール
# (offset 移動) を妨げないようかなり緩めに設定。
_feed_limiter = SlidingWindowRateLimiter(
    per_second=getattr(settings, "FEED_RATE_LIMIT_PER_SECOND", 20),
    per_minute=getattr(settings, "FEED_RATE_LIMIT_PER_MINUTE", 240),
    name="feed",
)


def get_feed_rate_limiter() -> SlidingWindowRateLimiter:
    return _feed_limiter


# ----------------------------------------------------------------------------
# /resolve-mp4 向けレートリミッタ
# ----------------------------------------------------------------------------
# DMM への外部リクエストを伴うため、events や feed よりも保守的に絞る。
# resolver_client 側に短期成功キャッシュ + in-flight デデュープがあるので、
# 通常閲覧フローでは十分に余裕がある。
_resolve_limiter = SlidingWindowRateLimiter(
    per_second=getattr(settings, "RESOLVE_RATE_LIMIT_PER_SECOND", 10),
    per_minute=getattr(settings, "RESOLVE_RATE_LIMIT_PER_MINUTE", 120),
    name="resolve_mp4",
)


def get_resolve_rate_limiter() -> SlidingWindowRateLimiter:
    return _resolve_limiter


# ----------------------------------------------------------------------------
# コメント投稿用レートリミッタ
# ----------------------------------------------------------------------------
# 匿名 POST が通る分、スパムに晒されやすい。1 秒 2 件 / 1 分 10 件と保守的。
# 重複本文ブロックや NG ワード判定は app/core/comment_spam.py で行い、
# この限り はそれより前段 (純粋な連打) を防ぐ役目を持つ。
_comment_limiter = SlidingWindowRateLimiter(
    per_second=getattr(settings, "COMMENT_RATE_LIMIT_PER_SECOND", 2),
    per_minute=getattr(settings, "COMMENT_RATE_LIMIT_PER_MINUTE", 10),
    name="comments",
)


def get_comment_rate_limiter() -> SlidingWindowRateLimiter:
    return _comment_limiter
