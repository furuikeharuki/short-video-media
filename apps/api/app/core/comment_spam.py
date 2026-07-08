"""コメントスパム対策ユーティリティ。

POST /movies/{slug}/comments 用の 3 層防御:

  1. SlidingWindowRateLimiter (rate_limit.py) — 純粋な連打を防ぐ。前段。
  2. DuplicateBodyGuard (本モジュール) — 同一 IP / ユーザーから同じ本文 (正規化後)
     を短時間に連続投稿させない。1 件 OK → 60 秒以内に同文を再送すると 429。
  3. NG ワードチェック (本モジュール) — 設定 COMMENT_NG_WORDS にマッチする
     コメントを 400 (Bad Request) で弾く。どの単語に当たったかは漏らさない。

すべて in-memory 実装。複数 API レプリカで動かす場合は Redis ベースの実装に
置き換える前提だが、現状の Railway / Xserver 1 インスタンス構成では十分。
"""
from __future__ import annotations

import re
import time
from collections import OrderedDict
from threading import Lock

from fastapi import HTTPException, Request, status

from app.core.config import settings
from app.core.rate_limit import client_ip


# 連続空白を 1 つに圧縮するための正規表現。
_WHITESPACE_RUN = re.compile(r"\s+")


def normalize_body(body: str) -> str:
    """重複判定 / NG ワード判定で使う正規化形。

    - 前後 strip
    - 内部の空白文字 (改行含む) を 1 個の半角空白に圧縮
    - 小文字化 (英字 NG ワードの大文字回避対策)
    """
    return _WHITESPACE_RUN.sub(" ", body.strip()).lower()


def contains_ng_word(normalized_body: str, ng_words: list[str]) -> bool:
    """正規化済み本文が NG ワード (小文字) のいずれかを含むか。

    空の ng_words は常に False (= チェックなし) を返す。
    """
    if not ng_words:
        return False
    return any(w and w in normalized_body for w in ng_words)


def assert_no_ng_word(body: str) -> None:
    """NG ワードを含むなら 400 を投げる。どの単語かは詳細に出さない。"""
    if contains_ng_word(normalize_body(body), settings.comment_ng_words_list):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Comment contains disallowed content",
        )


class DuplicateBodyGuard:
    """(identity, normalized_body) のペアごとに直近投稿時刻を保持し、
    window_sec 以内の同文連投を 429 で弾く。

    identity は「ログイン中なら user_id、未ログインなら IP」を想定。
    in-memory LRU で最大 entries エントリ保持し、古いものから自動破棄する。
    """

    def __init__(self, *, window_sec: int, max_entries: int = 10_000) -> None:
        self._window_sec = window_sec
        self._max_entries = max_entries
        # OrderedDict[(identity, normalized_body)] = last_post_monotonic
        self._store: OrderedDict[tuple[str, str], float] = OrderedDict()
        self._lock = Lock()

    def _evict_locked(self, now: float) -> None:
        # window_sec を超えた古いエントリを先頭から落とす。
        while self._store:
            oldest_key = next(iter(self._store))
            ts = self._store[oldest_key]
            if now - ts > self._window_sec:
                self._store.pop(oldest_key, None)
                continue
            break
        # 上限超過なら最古から強制削除。
        while len(self._store) > self._max_entries:
            self._store.popitem(last=False)

    def check(self, identity: str, normalized_body: str) -> None:
        """同一 identity + 同一 normalized_body が window_sec 以内に既に
        記録されていれば 429 を投げる。**記録はしない** (副作用なし)。

        「重複判定」と「記録」を分離することで、後続の検証 (親コメント存在
        チェック等) で 4xx になるリクエストの本文を誤って記録し、正しい
        再試行まで重複扱いにしてしまう問題を避ける。記録は投稿成功後に
        `record()` を呼ぶ。"""
        key = (identity, normalized_body)
        now = time.monotonic()
        with self._lock:
            self._evict_locked(now)
            last = self._store.get(key)
            if last is not None and now - last <= self._window_sec:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="Duplicate comment posted recently",
                )

    def record(self, identity: str, normalized_body: str) -> None:
        """`identity` + `normalized_body` の投稿時刻を記録する (投稿成功後に呼ぶ)。"""
        key = (identity, normalized_body)
        now = time.monotonic()
        with self._lock:
            self._evict_locked(now)
            # OrderedDict の末尾に置き直すことで LRU 性を維持
            self._store.pop(key, None)
            self._store[key] = now

    def check_and_record(self, identity: str, normalized_body: str) -> None:
        """`check()` して問題なければ `record()` する後方互換ヘルパ。

        重複記録による再試行の巻き添えを避けたい呼び出し元 (コメント作成
        エンドポイント) は `check()` と `record()` を個別に使うこと。"""
        self.check(identity, normalized_body)
        self.record(identity, normalized_body)

    # ---------- testing helpers --------------------------------------------
    def _size_for_tests(self) -> int:
        with self._lock:
            return len(self._store)

    def _reset_for_tests(self) -> None:
        with self._lock:
            self._store.clear()


_duplicate_guard = DuplicateBodyGuard(
    window_sec=getattr(settings, "COMMENT_DUPLICATE_WINDOW_SECONDS", 60),
)


def get_duplicate_body_guard() -> DuplicateBodyGuard:
    return _duplicate_guard


def identity_for_request(request: Request, user_id: str | None) -> str:
    """重複判定の identity。ログイン中はユーザー単位、匿名は IP 単位で見る。

    匿名は IP のみなので NAT 越し共有 IP では同じ文面を 1 人だけ投稿可能で、
    他人の同文も 429 になる副作用がある。スパム対策側に倒した設計。
    """
    if user_id is not None:
        return f"user:{user_id}"
    return f"ip:{client_ip(request)}"
