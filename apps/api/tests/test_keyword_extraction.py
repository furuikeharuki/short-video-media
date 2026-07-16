"""keyword_extraction.extract_keywords のユニットテスト。

実物風の日本語作品説明文フィクスチャで、
  - 特徴語が抽出されること
  - 1 文字語 / 数字 / 記号 / 伏字 (**) / ストップワードが除外されること
  - 頻度順・件数上限・欠損 (空/None) の扱い
を担保する。
"""
from __future__ import annotations

from app.services.keyword_extraction import STOPWORDS, extract_keywords

# 実物の FANZA 説明文を模したフィクスチャ。
# 「エステ」「メンズエステ」「盗撮」を繰り返し登場させ頻度差を作る。
# 「監督」「作品」「動画」はストップワード、「1」「00065」は数字、
# 「**」は伏字として除外されることを確認する。
SAMPLE_DESCRIPTION = (
    "人気メンズエステ店に潜入した盗撮ドキュメンタリー作品。"
    "エステの施術中に隠しカメラで撮影した映像です。"
    "メンズエステの本番交渉から始まり、盗撮ならではの生々しい"
    "エステ体験をお届けします。品番msoc00065、収録時間34分。"
    "この作品の監督が贈る渾身の1本。名前は**さん。"
)


def test_extracts_domain_keywords() -> None:
    keywords = extract_keywords(SAMPLE_DESCRIPTION)
    assert keywords, "キーワードが 1 つも抽出されていない"
    # 頻出のドメイン語が拾えている (janome/IPADIC は「メンズエステ」を
    # 「メンズ」+「エステ」に分割するため、トークン単位で検証する)。
    assert "エステ" in keywords
    assert "潜入" in keywords
    assert "ドキュメンタリー" in keywords


def test_frequency_ordering() -> None:
    keywords = extract_keywords(SAMPLE_DESCRIPTION)
    # 最頻出語 (エステ) が先頭に来る。
    assert keywords[0] == "エステ"


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
