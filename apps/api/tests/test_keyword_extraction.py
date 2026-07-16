"""keyword_extraction.extract_keywords のユニットテスト。

実物風の日本語作品説明文フィクスチャで、
  - 連続する名詞が複合語に連結されること (メンズエステ / 顔面騎乗位)
  - 複合語の内部にしか出ない断片 (メンズ 単体) が出力されないこと
  - 人名断片 (くら) や 1 文字語 / 数字 / 記号 / 伏字 (**) / ストップワードの除外
  - 頻度順・件数上限・欠損 (空/None) の扱い
を担保する。
"""
from __future__ import annotations

from app.services.keyword_extraction import STOPWORDS, extract_keywords

# 実物の FANZA 説明文を模したフィクスチャ。
# 「メンズエステ」を繰り返し登場させて最頻出にし、「顔面騎乗位」「本番交渉」など
# IPADIC が細切れにする複合語を含める。「くらちゃん」は人名 (くらしなひまり) の
# 愛称で、連結すると壊れた断片「くら」になるため除外されること、
# 「監督」「作品」はストップワード、「1」「00065」は数字、「**」は伏字として
# 除外されることを確認する。
SAMPLE_DESCRIPTION = (
    "メンズエステに潜入した盗撮ドキュメンタリー作品。"
    "メンズエステの施術中に隠しカメラで撮影した映像です。"
    "顔面騎乗位からの本番交渉、盗撮ならではの生々しいメンズエステ体験。"
    "出演はランカー嬢のくらちゃん。品番msoc00065、収録時間34分。"
    "この作品の監督が贈る渾身の1本。名前は**さん。"
)


def test_joins_compound_nouns() -> None:
    keywords = extract_keywords(SAMPLE_DESCRIPTION)
    assert keywords, "キーワードが 1 つも抽出されていない"
    # 連続名詞が 1 語に連結されている。
    assert "メンズエステ" in keywords
    assert "顔面騎乗位" in keywords
    assert "本番交渉" in keywords


def test_does_not_emit_broken_fragments() -> None:
    keywords = extract_keywords(SAMPLE_DESCRIPTION)
    # 複合語の内部にしか出ない断片は単独で出力しない。
    assert "メンズ" not in keywords
    assert "騎乗" not in keywords
    assert "顔面" not in keywords
    # 人名 (くらしなひまり) の壊れた断片は除外 (2 文字以下のひらがな断片)。
    assert "くら" not in keywords
    assert all(k != "くらし" for k in keywords)


def test_extracts_domain_keywords() -> None:
    keywords = extract_keywords(SAMPLE_DESCRIPTION)
    assert "潜入" in keywords
    assert "ドキュメンタリー" in keywords


def test_frequency_ordering() -> None:
    keywords = extract_keywords(SAMPLE_DESCRIPTION)
    # 最頻出語 (メンズエステ) が先頭に来る。
    assert keywords[0] == "メンズエステ"


def test_excludes_stopwords_numbers_and_masked() -> None:
    keywords = extract_keywords(SAMPLE_DESCRIPTION)
    # ストップワード
    assert "監督" not in keywords
    assert "作品" not in keywords
    assert "動画" not in keywords
    # 数字のみ / 1 文字
    assert "1" not in keywords
    assert "00065" not in keywords
    assert all(len(k) >= 2 for k in keywords)
    assert all(not k.isdigit() for k in keywords)
    # 伏字
    assert all("*" not in k for k in keywords)
    # 抽出語がストップワードと重ならない
    assert not (set(keywords) & STOPWORDS)


def test_max_keywords_cap() -> None:
    keywords = extract_keywords(SAMPLE_DESCRIPTION, max_keywords=3)
    assert len(keywords) <= 3


def test_empty_and_none() -> None:
    assert extract_keywords(None) == []
    assert extract_keywords("") == []
    assert extract_keywords("   ") == []


def test_deterministic() -> None:
    # 同じ入力は常に同じ結果 (決定的)。
    a = extract_keywords(SAMPLE_DESCRIPTION)
    b = extract_keywords(SAMPLE_DESCRIPTION)
    assert a == b
