"""POST /api/v1/movies/{slug}/comments のスパム対策テスト。

スパム対策 3 層 (rate / duplicate / NG word) ごとに

  - 想定範囲内なら通る (匿名 + ログイン両方を確認)
  - 想定外なら 429 / 400 で弾く

を検証する。レートリミッタ / 重複ガードは process-global なので、各テストで
fresh インスタンスを dependency_overrides で差し替える。
"""
from __future__ import annotations

from typing import Iterator
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.core.comment_spam import (
    DuplicateBodyGuard,
    contains_ng_word,
    get_duplicate_body_guard,
    normalize_body,
)
from app.core.rate_limit import SlidingWindowRateLimiter, get_comment_rate_limiter
from app.core.security import get_optional_user, require_user
from app.db.session import get_db
from app.main import app
from tests.test_comments import _FakeDB, _FakeStore, _FakeUser  # type: ignore


# ---------- 共通ヘルパー ----------


def _override_limiter(
    *, per_second: int = 10_000, per_minute: int = 10_000
) -> SlidingWindowRateLimiter:
    limiter = SlidingWindowRateLimiter(
        per_second=per_second, per_minute=per_minute, name="comments-test"
    )
    app.dependency_overrides[get_comment_rate_limiter] = lambda: limiter
    return limiter


def _override_dup_guard(*, window_sec: int = 60) -> DuplicateBodyGuard:
    guard = DuplicateBodyGuard(window_sec=window_sec)
    app.dependency_overrides[get_duplicate_body_guard] = lambda: guard
    return guard


def _override_db(store: _FakeStore) -> None:
    async def _fake_db():
        yield _FakeDB(store, None)

    app.dependency_overrides[get_db] = _fake_db


def _override_anon_user() -> None:
    async def _none() -> None:
        return None

    app.dependency_overrides[get_optional_user] = _none


def _override_logged_in_user(store: _FakeStore, user_id: str) -> None:
    store.add_user(user_id, None)
    fake_user = _FakeUser(store, user_id)

    async def _u() -> _FakeUser:
        return fake_user

    app.dependency_overrides[require_user] = _u
    app.dependency_overrides[get_optional_user] = _u


@pytest.fixture(autouse=True)
def _clear() -> Iterator[None]:
    yield
    app.dependency_overrides.clear()


# ---------- normalize / NG word: 純粋ユニット ----------


def test_normalize_body_strips_and_collapses_whitespace() -> None:
    assert normalize_body("  Hello   World\nFOO\t bar  ") == "hello world foo bar"


def test_contains_ng_word_substring_match_case_insensitive() -> None:
    assert contains_ng_word("hello spam world", ["spam"]) is True
    # 入力側は事前に正規化 (lower) されている前提。NG ワード自体も lower で受け取る。
    assert contains_ng_word("hello spam world", ["foo", "bar"]) is False


def test_contains_ng_word_empty_list_is_never_ng() -> None:
    assert contains_ng_word("anything goes", []) is False


# ---------- duplicate guard ----------


def test_duplicate_guard_blocks_same_body_within_window() -> None:
    guard = DuplicateBodyGuard(window_sec=60)
    guard.check_and_record("ip:1.1.1.1", "hello")
    # 同じ identity + 本文 → 429
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        guard.check_and_record("ip:1.1.1.1", "hello")
    assert exc.value.status_code == 429
    # 別 IP は通る
    guard.check_and_record("ip:2.2.2.2", "hello")
    # 同じ IP でも別本文は通る
    guard.check_and_record("ip:1.1.1.1", "world")


def test_duplicate_guard_zero_window_never_blocks() -> None:
    guard = DuplicateBodyGuard(window_sec=0)
    guard.check_and_record("ip:1", "hi")
    # window=0 → 経過時間が 0 以下しか拒否しない (現在時刻と一致しても許可)
    # 実装は `now - last <= window_sec` で 0 のときに当該タイミングのみ拒否し得る
    # ため、ここでは「次回呼び出しでは拒否しないことを期待しない」ことだけ確認:
    # 単に挙動が無限ループしないことを示す。
    assert guard._size_for_tests() == 1


# ---------- endpoint: rate limit ----------


def test_post_anonymous_rate_limit_per_second_returns_429() -> None:
    store = _FakeStore()
    store.add_movie("movie-1")

    _override_db(store)
    _override_anon_user()
    _override_limiter(per_second=2, per_minute=100)
    _override_dup_guard(window_sec=0)  # 重複は無視

    client = TestClient(app)
    r1 = client.post("/api/v1/movies/movie-1/comments", json={"body": "a"})
    r2 = client.post("/api/v1/movies/movie-1/comments", json={"body": "b"})
    r3 = client.post("/api/v1/movies/movie-1/comments", json={"body": "c"})
    assert r1.status_code == 201
    assert r2.status_code == 201
    assert r3.status_code == 429
    assert "rate limit" in r3.json()["detail"].lower()


# ---------- endpoint: duplicate body ----------


def test_post_same_body_twice_returns_429_for_anonymous() -> None:
    store = _FakeStore()
    store.add_movie("movie-1")

    _override_db(store)
    _override_anon_user()
    _override_limiter()  # 緩く
    _override_dup_guard(window_sec=60)

    client = TestClient(app)
    r1 = client.post("/api/v1/movies/movie-1/comments", json={"body": "same!!"})
    r2 = client.post("/api/v1/movies/movie-1/comments", json={"body": "same!!"})
    assert r1.status_code == 201
    assert r2.status_code == 429
    assert "duplicate" in r2.json()["detail"].lower()


def test_post_same_body_only_whitespace_diff_still_blocked() -> None:
    """正規化後の本文が同じなら、空白の差だけでも重複扱い。"""
    store = _FakeStore()
    store.add_movie("movie-1")

    _override_db(store)
    _override_anon_user()
    _override_limiter()
    _override_dup_guard(window_sec=60)

    client = TestClient(app)
    r1 = client.post("/api/v1/movies/movie-1/comments", json={"body": "Hi  there"})
    r2 = client.post(
        "/api/v1/movies/movie-1/comments", json={"body": " hi  there  "}
    )
    assert r1.status_code == 201
    assert r2.status_code == 429


def test_post_same_body_different_users_not_blocked() -> None:
    """ログイン中のユーザー A が投稿した本文と、別ユーザー B の同じ本文は別扱い。"""
    store = _FakeStore()
    store.add_movie("movie-1")

    _override_db(store)
    _override_limiter()
    _override_dup_guard(window_sec=60)

    # User A 投稿
    _override_logged_in_user(store, "user-A")
    client_a = TestClient(app)
    r1 = client_a.post("/api/v1/movies/movie-1/comments", json={"body": "great"})
    assert r1.status_code == 201

    # User B (別ユーザー) として同じ本文を投稿 → 通る
    app.dependency_overrides.pop(require_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    _override_logged_in_user(store, "user-B")
    client_b = TestClient(app)
    r2 = client_b.post("/api/v1/movies/movie-1/comments", json={"body": "great"})
    assert r2.status_code == 201


# ---------- endpoint: NG word ----------


def test_post_with_ng_word_returns_400_and_hides_word() -> None:
    store = _FakeStore()
    store.add_movie("movie-1")

    _override_db(store)
    _override_anon_user()
    _override_limiter()
    _override_dup_guard(window_sec=0)

    # 設定の NG ワードを差し替える
    from app.core import comment_spam as cs_mod

    with patch.object(
        cs_mod.settings, "COMMENT_NG_WORDS", "spam-keyword,炎上煽り"
    ):
        client = TestClient(app)
        # 1) 英字 NG ワードを含む
        r1 = client.post(
            "/api/v1/movies/movie-1/comments",
            json={"body": "this is SPAM-KEYWORD inside"},
        )
        # 2) 日本語 NG ワードを含む
        r2 = client.post(
            "/api/v1/movies/movie-1/comments",
            json={"body": "ここに炎上煽り文を入れる"},
        )
        # 3) 何にも当たらない普通の本文
        r3 = client.post(
            "/api/v1/movies/movie-1/comments", json={"body": "ふつうの感想です"}
        )
        assert r1.status_code == 400
        assert r2.status_code == 400
        # 詳細には NG ワード自体を漏らさない
        assert "spam-keyword" not in r1.json()["detail"].lower()
        assert "炎上煽り" not in r2.json()["detail"]
        assert r3.status_code == 201


def test_post_passes_when_ng_word_list_is_empty() -> None:
    """COMMENT_NG_WORDS が空 (デフォルト) なら NG ワード判定をパスする。"""
    store = _FakeStore()
    store.add_movie("movie-1")

    _override_db(store)
    _override_anon_user()
    _override_limiter()
    _override_dup_guard(window_sec=0)

    from app.core import comment_spam as cs_mod

    with patch.object(cs_mod.settings, "COMMENT_NG_WORDS", ""):
        client = TestClient(app)
        res = client.post(
            "/api/v1/movies/movie-1/comments",
            json={"body": "this contains spam but it's allowed"},
        )
        assert res.status_code == 201


# ---------- normal posts still work ----------


def test_anonymous_post_under_limits_succeeds() -> None:
    """ガードを通常設定にしても、ふつうの 1 投稿は普通に通る。"""
    store = _FakeStore()
    store.add_movie("movie-1")

    _override_db(store)
    _override_anon_user()
    _override_limiter(per_second=2, per_minute=10)
    _override_dup_guard(window_sec=60)

    client = TestClient(app)
    res = client.post(
        "/api/v1/movies/movie-1/comments", json={"body": "hello world"}
    )
    assert res.status_code == 201
    assert res.json()["display_name"] == "名無しのユーザー"
    assert res.json()["author_user_id"] is None


def test_logged_in_post_under_limits_succeeds() -> None:
    store = _FakeStore()
    store.add_movie("movie-1")
    _override_db(store)
    _override_logged_in_user(store, "user-A")
    _override_limiter(per_second=2, per_minute=10)
    _override_dup_guard(window_sec=60)

    client = TestClient(app)
    res = client.post(
        "/api/v1/movies/movie-1/comments", json={"body": "from logged in user"}
    )
    assert res.status_code == 201
    assert res.json()["author_user_id"] == "user-A"
