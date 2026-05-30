"""X 投稿の本文テンプレート群と sanitize 処理。

成人向けサイトの誘導ポストなので、露骨すぎる表現は避け、
「サイト名 / ショート動画で試し見 / 女優・ジャンル案内」程度に留める。

安全策:
  - 本文に `@` を入れない (メンション化の防止)。女優名等に `@` が含まれる場合は
    全角 `＠` に置換して無害化する。
  - ハッシュタグは乱用しない。初期実装では一切付けない。
  - 文面は種別ごとに複数用意し、日付+スロットで決定的に選んで連投感を減らす。
"""
from __future__ import annotations

from datetime import date

from src.post_candidates import PostCandidate

# 18 歳未満が見る前提のプラットフォーム向けに、固定の年齢注意書きを付ける。
_AGE_NOTE = "※18歳未満閲覧禁止"

# 種別ごとの本文テンプレート。{title} と {url} を後で埋める。
# 露骨な語は避け、誘導の文脈だけにする。
_TEMPLATES: dict[str, list[str]] = {
    "feed": [
        "このショート動画をチェック✨\n「{title}」\n{url}",
        "新着ショート動画はこちら👀\n{title}\n{url}",
        "縦スクロールでサクッと試し見📱\n「{title}」\n{url}",
        "今日のおすすめショート動画\n{title}\n{url}",
        "気になる一本をショートで✨\n「{title}」\n{url}",
    ],
    "movie": [
        "話題の作品をショート動画でチェック✨\n「{title}」\n{url}",
        "今注目のショート動画はこちら👀\n{title}\n{url}",
        "サンプルをサクッと試し見📱\n「{title}」\n{url}",
        "気になる新着作品をピックアップ\n{title}\n{url}",
    ],
    "actress": [
        "{title} さんの出演作品まとめ✨\nショート動画で試し見できます\n{url}",
        "人気女優をチェック👀\n{title} さんの作品一覧はこちら\n{url}",
        "{title} さんのショート動画まとめ📱\n{url}",
    ],
    "genre": [
        "「{title}」のショート動画を集めました✨\n{url}",
        "今日は「{title}」気分？👀\nまとめてチェック\n{url}",
        "ジャンル「{title}」の人気作をピックアップ\n{url}",
    ],
}


def sanitize_text(text: str) -> str:
    """投稿本文を無害化する。

    - `@` を全角 `＠` に置換 (誤メンション防止)。リンクの URL には `@` を含めない
      設計なので、本文側だけ置換すれば十分。
    - 前後の空白を除去。
    """
    return text.replace("@", "＠").strip()


def render_post(candidate: PostCandidate, d: date, slot: int) -> str:
    """候補とローテーション情報から投稿本文を組み立てる。

    テンプレート選択も日付+スロットで決定的にずらし、同じ文面の連投を避ける。
    """
    templates = _TEMPLATES.get(candidate.kind) or _TEMPLATES["movie"]
    idx = (d.toordinal() + slot) % len(templates)
    # title に改行が混ざるとレイアウトが崩れるので 1 行に潰してから埋める。
    # @ 除去は完成本文の行単位 sanitize (_sanitize_keep_url) でまとめて行う。
    title = candidate.title.replace("\n", " ").strip()
    body = templates[idx].format(title=title, url=candidate.url)
    return _sanitize_keep_url(f"{body}\n{_AGE_NOTE}")


def _sanitize_keep_url(text: str) -> str:
    """完成本文を行単位で sanitize する。

    URL を壊さないよう、`http` で始まる行だけ `@` 置換から除外する。
    実際には URL に `@` は含まれない設計だが、保険として行単位で処理する。
    """
    lines = []
    for line in text.split("\n"):
        if line.startswith("http"):
            lines.append(line.strip())
        else:
            lines.append(line.replace("@", "＠").strip())
    return "\n".join(lines)
