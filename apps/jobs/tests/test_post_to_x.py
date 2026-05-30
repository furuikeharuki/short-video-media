"""X 自動投稿ボットの純粋ロジックをテストする (実際の投稿は行わない)。

- 投稿候補の組み立て (canonical URL / UTM / 種別)
- 種別・文面の決定的ローテーション
- 安全策: 本文に `@` が出ない / リプライ要素がない / URL が av-shorts.com
- X 認証情報の env パース (欠落で None)
- OAuth1.0a 署名ヘッダの形式
"""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

# apps/jobs/src を import パスに追加
_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[1]))

from src.post_candidates import (  # noqa: E402
    PostCandidate,
    actress_url,
    build_candidates,
    genre_url,
    movie_url,
    pick_candidate,
    rotate_kind,
)
from src.post_templates import render_post, sanitize_text  # noqa: E402
from src.x_client import XCredentials, _build_oauth1_header  # noqa: E402


# ---------------------------------------------------------------------------
# URL 組み立て
# ---------------------------------------------------------------------------

def test_urls_are_canonical_av_shorts_with_utm():
    assert movie_url("abc-123").startswith("https://av-shorts.com/movies/abc-123?")
    assert "utm_source=x" in movie_url("abc-123")
    assert "utm_medium=social" in actress_url("七海")
    assert "utm_campaign=bot" in genre_url("ドラマ")


def test_urls_encode_japanese():
    url = actress_url("七海ティナ")
    # 日本語はパーセントエンコードされ、生のマルチバイトは残らない
    assert "七海" not in url
    assert url.startswith("https://av-shorts.com/actresses/")


def test_urls_never_contain_at_sign():
    for url in (movie_url("a@b"), actress_url("name@x"), genre_url("g@h")):
        assert "@" not in url


# ---------------------------------------------------------------------------
# 候補組み立て
# ---------------------------------------------------------------------------

_SAMPLE_HOME = {
    "sections": [
        {
            "key": "popular",
            "title": "人気動画",
            "items": [
                {"slug": "movie-1", "title": "作品その1"},
                {"slug": "movie-2", "title": "作品その2"},
            ],
        },
        {
            "key": "genre_1",
            "title": "#ドラマ",
            "genre": "ドラマ",
            "items": [{"slug": "movie-3", "title": "作品その3"}],
        },
    ],
    "actress_sections": [
        {
            "key": "popular_actresses",
            "title": "人気女優",
            "items": [
                {"id": 1, "name": "女優A"},
                {"id": 2, "name": "女優B"},
            ],
        }
    ],
}


def test_build_candidates_splits_by_kind():
    c = build_candidates(_SAMPLE_HOME)
    assert {x.title for x in c["movie"]} == {"作品その1", "作品その2", "作品その3"}
    assert {x.title for x in c["actress"]} == {"女優A", "女優B"}
    assert {x.title for x in c["genre"]} == {"ドラマ"}
    # それぞれ canonical URL を持つ
    assert all(x.url.startswith("https://av-shorts.com/") for vals in c.values() for x in vals)


def test_build_candidates_handles_empty_home():
    c = build_candidates({})
    assert c == {"movie": [], "actress": [], "genre": []}


# ---------------------------------------------------------------------------
# ローテーション (決定的・重複回避)
# ---------------------------------------------------------------------------

def test_rotate_kind_cycles_over_three_kinds():
    d = date(2026, 1, 1)
    kinds = {rotate_kind(d, slot) for slot in range(6)}
    assert kinds == {"movie", "actress", "genre"}


def test_pick_candidate_is_deterministic():
    c = build_candidates(_SAMPLE_HOME)
    d = date(2026, 5, 30)
    first = pick_candidate(c, d, 0)
    second = pick_candidate(c, d, 0)
    assert first == second
    assert first is not None


def test_pick_candidate_varies_across_slots():
    c = build_candidates(_SAMPLE_HOME)
    d = date(2026, 5, 30)
    picks = [pick_candidate(c, d, slot) for slot in range(3)]
    # 少なくとも 2 種類以上の候補が選ばれる (連投感の軽減)
    assert len({p.url for p in picks if p}) >= 2


def test_pick_candidate_falls_back_when_kind_empty():
    # genre だけ存在する home でも、movie 種別の日に genre へフォールバックする
    only_genre = {
        "sections": [{"key": "genre_1", "title": "#ドラマ", "genre": "ドラマ", "items": []}],
        "actress_sections": [],
    }
    c = build_candidates(only_genre)
    got = pick_candidate(c, date(2026, 1, 1), 0)
    assert got is not None
    assert got.kind == "genre"


def test_pick_candidate_none_when_empty():
    assert pick_candidate(build_candidates({}), date(2026, 1, 1), 0) is None


# ---------------------------------------------------------------------------
# 本文生成と安全策
# ---------------------------------------------------------------------------

def test_render_post_has_no_at_mention():
    cand = PostCandidate(kind="actress", title="＠悪意のある名前@", url=actress_url("x"))
    text = render_post(cand, date(2026, 5, 30), 0)
    # URL 以外の行に半角 @ が残らない
    for line in text.split("\n"):
        if not line.startswith("http"):
            assert "@" not in line


def test_render_post_includes_url_and_age_note():
    cand = PostCandidate(kind="movie", title="作品", url=movie_url("slug-x"))
    text = render_post(cand, date(2026, 5, 30), 0)
    assert "https://av-shorts.com/movies/slug-x" in text
    assert "18歳未満閲覧禁止" in text


def test_render_post_within_length_limit():
    cand = PostCandidate(kind="actress", title="あ" * 50, url=actress_url("x" * 50))
    text = render_post(cand, date(2026, 5, 30), 0)
    assert len(text) <= 280


def test_render_post_uses_no_hashtags():
    cand = PostCandidate(kind="genre", title="ドラマ", url=genre_url("ドラマ"))
    text = render_post(cand, date(2026, 5, 30), 0)
    assert "#" not in text


def test_sanitize_text_replaces_at():
    assert "@" not in sanitize_text("hello @world")


# ---------------------------------------------------------------------------
# X 認証情報
# ---------------------------------------------------------------------------

def test_credentials_none_when_incomplete(monkeypatch):
    for k in ("X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("X_API_KEY", "only-one")
    assert XCredentials.from_env() is None


def test_credentials_loaded_when_complete(monkeypatch):
    monkeypatch.setenv("X_API_KEY", "k")
    monkeypatch.setenv("X_API_SECRET", "s")
    monkeypatch.setenv("X_ACCESS_TOKEN", "t")
    monkeypatch.setenv("X_ACCESS_TOKEN_SECRET", "ts")
    creds = XCredentials.from_env()
    assert creds is not None
    assert creds.api_key == "k"


def test_oauth1_header_format():
    creds = XCredentials(
        api_key="ck", api_secret="cs", access_token="at", access_token_secret="ats"
    )
    header = _build_oauth1_header(
        creds, "POST", "https://api.twitter.com/2/tweets",
        nonce="abc", timestamp="1700000000",
    )
    assert header.startswith("OAuth ")
    assert 'oauth_consumer_key="ck"' in header
    assert "oauth_signature=" in header
    assert 'oauth_signature_method="HMAC-SHA1"' in header
