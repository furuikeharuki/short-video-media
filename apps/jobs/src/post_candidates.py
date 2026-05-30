"""X 自動投稿の「投稿候補」を組み立てるロジック。

公開 API (`GET /api/v1/home`) からサイト内の人気/新着コンテンツを取得し、
女優ページ・ジャンルページ・作品ページへの誘導ポストを生成する。

設計方針:
  - DB / SSH に依存せず、公開 API だけで動く (GitHub Actions 上で完結)。
  - 投稿先 URL は必ず canonical な `https://av-shorts.com/...` を組み立てる。
    API が返す DMM アフィリエイト URL や API ドメインは使わない。
  - 他人に作用する要素 (@mention / reply) は構造的に作れないようにする。
    本文に女優名などの `@` が混入しても sanitize で除去する。
  - 同じ文面・同じ URL の連投を避けるため、日付・スロット・候補種別で
    決定的にローテーションする (永続ストレージ不要)。
"""
from __future__ import annotations

import urllib.parse
from dataclasses import dataclass
from datetime import date
from typing import Any, Literal

import httpx

SITE_URL = "https://av-shorts.com"

# feed = 縦スクロール試し見フィード (/feed?v=<slug>)。流入施策の主役なので最優先で投稿する。
CandidateKind = Literal["feed", "movie", "actress", "genre"]

# 投稿 URL に付ける軽量 UTM。過剰なパラメータは付けない。
_UTM = "utm_source=x&utm_medium=social&utm_campaign=bot"


@dataclass(frozen=True)
class PostCandidate:
    kind: CandidateKind
    title: str          # 女優名 / ジャンル名 / 作品タイトル
    url: str            # canonical な av-shorts.com URL (UTM 付き)


def _with_utm(path: str) -> str:
    """canonical path に UTM を付けた絶対 URL を返す。"""
    sep = "&" if "?" in path else "?"
    return f"{SITE_URL}{path}{sep}{_UTM}"


def feed_url(slug: str) -> str:
    """縦スクロール試し見フィードの該当動画 URL。

    フロントは `/feed?v=<slug>` の `v` を作品 slug (= content_id) として解決し
    (`getMovieBySlug`)、その動画を先頭に差し込んだフィードを表示する。
    `?v=` を先に置き、UTM はその後ろに付ける (クエリ順序: v → utm_*)。
    """
    q = urllib.parse.quote(slug, safe="")
    return _with_utm(f"/feed?v={q}")


def movie_url(slug: str) -> str:
    return _with_utm(f"/movies/{urllib.parse.quote(slug, safe='')}")


def actress_url(name: str) -> str:
    return _with_utm(f"/actresses/{urllib.parse.quote(name, safe='')}")


def genre_url(name: str) -> str:
    return _with_utm(f"/genres/{urllib.parse.quote(name, safe='')}")


def fetch_home(api_base_url: str, *, client: httpx.Client | None = None) -> dict[str, Any]:
    """公開 API の /api/v1/home を取得して dict で返す。"""
    url = f"{api_base_url.rstrip('/')}/api/v1/home"
    owns = client is None
    http = client or httpx.Client(timeout=20)
    try:
        res = http.get(url, params={"section_limit": 30})
        res.raise_for_status()
        return res.json()
    finally:
        if owns:
            http.close()


def _iter_movie_items(home: dict[str, Any]):
    """人気・新着セクションの (slug, title) を重複なく優先順で yield する。"""
    seen: set[str] = set()
    # 「人気動画」「新着」「本日配信開始」を優先的に拾う
    preferred = {"popular", "recent", "new", "ranking_weekly", "ranking_daily"}
    sections = home.get("sections") or []
    # preferred を前に並べ替えてから走査する
    ordered = sorted(
        sections,
        key=lambda s: 0 if s.get("key") in preferred else 1,
    )
    for sec in ordered:
        for item in sec.get("items") or []:
            slug = item.get("slug")
            title = item.get("title")
            if not slug or not title or slug in seen:
                continue
            seen.add(slug)
            yield slug, title


def _feed_candidates(home: dict[str, Any]) -> list[PostCandidate]:
    """作品セクションから feed (/feed?v=<slug>) 候補を作る。

    流入施策の主役。作品 (movie) と同じ slug を使い、誘導先だけ縦スクロール
    フィードに変える。
    """
    return [
        PostCandidate(kind="feed", title=title, url=feed_url(slug))
        for slug, title in _iter_movie_items(home)
    ]


def _movie_candidates(home: dict[str, Any]) -> list[PostCandidate]:
    """人気・新着セクションから作品詳細ページ候補を作る。"""
    return [
        PostCandidate(kind="movie", title=title, url=movie_url(slug))
        for slug, title in _iter_movie_items(home)
    ]


def _actress_candidates(home: dict[str, Any]) -> list[PostCandidate]:
    """人気女優セクションから女優候補を作る。"""
    out: list[PostCandidate] = []
    seen: set[str] = set()
    for sec in home.get("actress_sections") or []:
        for item in sec.get("items") or []:
            name = item.get("name")
            if not name or name in seen:
                continue
            seen.add(name)
            out.append(PostCandidate(kind="actress", title=name, url=actress_url(name)))
    return out


def _genre_candidates(home: dict[str, Any]) -> list[PostCandidate]:
    """ジャンルセクション (key が genre_* / genre フィールド) からジャンル候補を作る。"""
    out: list[PostCandidate] = []
    seen: set[str] = set()
    for sec in home.get("sections") or []:
        name = sec.get("genre")
        if not name:
            continue
        if name in seen:
            continue
        seen.add(name)
        out.append(PostCandidate(kind="genre", title=name, url=genre_url(name)))
    return out


def build_candidates(home: dict[str, Any]) -> dict[CandidateKind, list[PostCandidate]]:
    """home レスポンスを種別ごとの候補リストに変換する。"""
    return {
        "feed": _feed_candidates(home),
        "movie": _movie_candidates(home),
        "actress": _actress_candidates(home),
        "genre": _genre_candidates(home),
    }


# 種別ローテーションのスロット配分。
# 流入施策の主役である feed (/feed?v=<slug>) を「一番多く」投稿するため、
# 8 スロット中 6 枠 (= 75%) を feed に割り当て、残りを作品詳細/女優/ジャンルへ回す。
# slot は cron が叩いた時刻ではなく「その日の通し番号」を想定し、決定論性のために使う。
_ROTATION_PATTERN: list[CandidateKind] = [
    "feed",
    "feed",
    "movie",
    "feed",
    "feed",
    "actress",
    "feed",
    "feed",
    "genre",
    "feed",
]
# feed が連続しても URL/文面はリスト内 offset とテンプレ選択でずれるため、
# 同一動画の連投にはならない (build 側で重複 slug は排除済み)。


def rotate_kind(d: date, slot: int) -> CandidateKind:
    """日付とスロット番号から投稿する種別を決定的にローテーションする。

    feed を最多 (約 75%) にしつつ、作品詳細・女優・ジャンルも一定割合で混ぜる。
    永続ストレージを持たずに短期重複を避けるための決定的ルール。
    """
    idx = (d.toordinal() + slot) % len(_ROTATION_PATTERN)
    return _ROTATION_PATTERN[idx]


def pick_candidate(
    candidates: dict[CandidateKind, list[PostCandidate]],
    d: date,
    slot: int,
) -> PostCandidate | None:
    """種別ローテーションに従って 1 件選ぶ。

    決定した種別に候補が無ければ、他の種別へフォールバックする
    (feed → movie → actress → genre の順、feed 最優先)。リスト内の選択も
    日付+スロットで決定的にずらして、同じ先頭要素ばかり投稿しないようにする。
    """
    kind = rotate_kind(d, slot)
    fallback_order: list[CandidateKind] = [kind, "feed", "movie", "actress", "genre"]
    seen_kinds: set[CandidateKind] = set()
    for k in fallback_order:
        if k in seen_kinds:
            continue
        seen_kinds.add(k)
        items = candidates.get(k) or []
        if not items:
            continue
        # リスト内インデックスも決定的にローテーション
        offset = (d.toordinal() + slot) % len(items)
        return items[offset]
    return None
