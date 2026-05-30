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
    _ROTATION_PATTERN,
    PostCandidate,
    actress_url,
    build_candidates,
    feed_url,
    genre_url,
    movie_url,
    pick_candidate,
    rotate_kind,
)
from src.post_templates import render_post, sanitize_text  # noqa: E402
from src.x_client import (  # noqa: E402
    X_TWEETS_ENDPOINT,
    X_USER_AGENT,
    PostResult,
    XCredentials,
    _build_oauth1_header,
    post_tweet,
)


# ---------------------------------------------------------------------------
# URL 組み立て
# ---------------------------------------------------------------------------

def test_urls_are_canonical_av_shorts_with_utm():
    assert movie_url("abc-123").startswith("https://av-shorts.com/movies/abc-123?")
    assert "utm_source=x" in movie_url("abc-123")
    assert "utm_medium=social" in actress_url("七海")
    assert "utm_campaign=bot" in genre_url("ドラマ")


def test_feed_url_uses_v_param_then_utm():
    # ユーザー例: https://av-shorts.com/feed?v=miaa00574
    url = feed_url("miaa00574")
    assert url.startswith("https://av-shorts.com/feed?v=miaa00574")
    # v が先、UTM はその後ろ (クエリ順序: v → utm_*)
    assert url == (
        "https://av-shorts.com/feed?v=miaa00574"
        "&utm_source=x&utm_medium=social&utm_campaign=bot"
    )
    assert url.index("v=miaa00574") < url.index("utm_source=x")


def test_feed_url_encodes_special_chars_and_no_at():
    url = feed_url("a/b @c")
    assert "@" not in url
    # スラッシュや空白は v 値としてエンコードされ、クエリ構造を壊さない
    assert url.startswith("https://av-shorts.com/feed?v=")
    assert url.count("?") == 1


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


def test_build_candidates_feed_uses_same_slugs_as_movies():
    c = build_candidates(_SAMPLE_HOME)
    # feed 候補は作品と同じ slug を /feed?v= に流用する
    assert {x.title for x in c["feed"]} == {"作品その1", "作品その2", "作品その3"}
    assert all(x.kind == "feed" for x in c["feed"])
    assert all(x.url.startswith("https://av-shorts.com/feed?v=") for x in c["feed"])
    assert c["feed"][0].url.startswith("https://av-shorts.com/feed?v=movie-1")


def test_build_candidates_handles_empty_home():
    c = build_candidates({})
    assert c == {"feed": [], "movie": [], "actress": [], "genre": []}


# ---------------------------------------------------------------------------
# ローテーション (決定的・重複回避)
# ---------------------------------------------------------------------------

def test_rotate_kind_cycles_over_all_kinds():
    d = date(2026, 1, 1)
    kinds = {rotate_kind(d, slot) for slot in range(len(_ROTATION_PATTERN))}
    assert kinds == {"feed", "movie", "actress", "genre"}


def test_rotate_kind_makes_feed_the_majority():
    # 1 パターン周期のうち feed が 70% 以上を占める (流入施策の主役)
    d = date(2026, 1, 1)
    span = len(_ROTATION_PATTERN)
    feed_slots = sum(1 for slot in range(span) if rotate_kind(d, slot) == "feed")
    assert feed_slots / span >= 0.7
    # どの開始日でも同じ配分になる (決定的・日付非依存の比率)
    d2 = date(2026, 7, 15)
    feed_slots2 = sum(1 for slot in range(span) if rotate_kind(d2, slot) == "feed")
    assert feed_slots2 == feed_slots


def test_feed_is_most_picked_kind_over_a_window():
    # 実候補を使い、複数スロットで pick したとき feed が最多になることを確認
    c = build_candidates(_SAMPLE_HOME)
    d = date(2026, 5, 30)
    picks = [pick_candidate(c, d, slot) for slot in range(16)]
    feed_count = sum(1 for p in picks if p and p.kind == "feed")
    other_max = max(
        sum(1 for p in picks if p and p.kind == k)
        for k in ("movie", "actress", "genre")
    )
    assert feed_count > other_max


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


def test_render_feed_post_includes_feed_url_and_natural_copy():
    cand = PostCandidate(kind="feed", title="作品X", url=feed_url("miaa00574"))
    text = render_post(cand, date(2026, 5, 30), 0)
    assert "https://av-shorts.com/feed?v=miaa00574" in text
    assert "18歳未満閲覧禁止" in text
    assert "ショート動画" in text  # feed 向けの自然な文面
    assert "@" not in text
    assert "#" not in text


def test_feed_picks_avoid_consecutive_duplicate_urls():
    # feed が連投されても、隣り合うスロットで同じ URL は出さない
    c = build_candidates(_SAMPLE_HOME)
    d = date(2026, 5, 30)
    picks = [pick_candidate(c, d, slot) for slot in range(8)]
    urls = [p.url for p in picks if p]
    for a, b in zip(urls, urls[1:]):
        assert a != b


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
        creds, "POST", X_TWEETS_ENDPOINT,
        nonce="abc", timestamp="1700000000",
    )
    assert header.startswith("OAuth ")
    assert 'oauth_consumer_key="ck"' in header
    assert "oauth_signature=" in header
    assert 'oauth_signature_method="HMAC-SHA1"' in header


# ---------------------------------------------------------------------------
# 投稿エンドポイント: 必ず公式 API ホスト (api.x.com) を使う
#
# 通常 Web ホスト (https://x.com/...) に向けると Cloudflare のボット保護で
# 403 + "Just a moment..." HTML が返り投稿が失敗するため、ホストを検証する。
# ---------------------------------------------------------------------------

def test_endpoint_uses_official_api_host():
    assert X_TWEETS_ENDPOINT == "https://api.x.com/2/tweets"


def test_endpoint_is_not_web_host():
    # 通常 Web ホスト (x.com / www.x.com / twitter.com の Web 側) は使わない。
    assert not X_TWEETS_ENDPOINT.startswith("https://x.com/")
    assert not X_TWEETS_ENDPOINT.startswith("https://www.x.com/")
    assert not X_TWEETS_ENDPOINT.startswith("https://twitter.com/")
    # api. サブドメインの公式ホストであること。
    assert X_TWEETS_ENDPOINT.startswith("https://api.")


class _FakeResponse:
    def __init__(self, status_code: int, json_body=None, text: str = ""):
        self.status_code = status_code
        self._json = json_body or {}
        self.text = text

    def json(self):
        return self._json


class _FakeClient:
    """post 先 URL / headers を記録するだけのスタブ。"""

    def __init__(self, response: _FakeResponse):
        self._response = response
        self.last_url: str | None = None
        self.last_headers: dict | None = None

    def post(self, url, headers=None, json=None):
        self.last_url = url
        self.last_headers = headers
        return self._response


def test_post_tweet_posts_to_official_api_host():
    creds = XCredentials(
        api_key="ck", api_secret="cs", access_token="at", access_token_secret="ats"
    )
    client = _FakeClient(_FakeResponse(201, {"data": {"id": "123"}}))
    result = post_tweet(creds, "hello", client=client)

    assert isinstance(result, PostResult)
    assert result.ok is True
    assert result.tweet_id == "123"
    # 実際に叩いた URL が公式 API ホストであること。
    assert client.last_url == "https://api.x.com/2/tweets"
    assert client.last_url.startswith("https://api.x.com/")
    assert "://x.com/" not in client.last_url


def test_post_tweet_sets_browser_like_user_agent():
    # Cloudflare がデフォルト python-httpx UA をチャレンジするのを避けるため、
    # 明示的な User-Agent を送る。
    creds = XCredentials(
        api_key="ck", api_secret="cs", access_token="at", access_token_secret="ats"
    )
    client = _FakeClient(_FakeResponse(201, {"data": {"id": "1"}}))
    post_tweet(creds, "hi", client=client)

    assert client.last_headers is not None
    ua = client.last_headers.get("User-Agent")
    assert ua == X_USER_AGENT
    assert "python-httpx" not in (ua or "")
