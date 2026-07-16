"""keyword_extraction.extract_keywords のユニットテスト。

実物風の日本語作品説明文フィクスチャで、
  - 連続する名詞が複合語に連結されること (メンズエステ / 顔面騎乗位)
  - 複合語の内部にしか出ない断片 (メンズ 単体) が出力されないこと
  - 別の語の部分文字列になる断片 (くらし ⊂ くらしな) が統合・除外されること
  - 人名断片 (くら) や 1 文字語 / 数字 / 記号 / 伏字 (**) / ストップワードの除外
  - 頻度順・件数上限・欠損 (空/None) の扱い
を担保する。
"""
from __future__ import annotations

from app.services.keyword_extraction import STOPWORDS, extract_keywords

# 実物の FANZA 説明文を模したフィクスチャ。
# 「メンズエステ」を繰り返し登場させて最頻出にし、「顔面騎乗位」「本番交渉」など
# IPADIC が細切れにする複合語を含める。人名 (くらしなひまり) 由来の「くらしな」と、
# その部分文字列「くらし」が両方生成されるが、後者は前者に統合されて出力されない
# ことを確認する。「監督」「作品」はストップワード、「1」「00065」は数字、
# 「**」は伏字として除外されることも確認する。
SAMPLE_DESCRIPTION = (
    "メンズエステに潜入した盗撮ドキュメンタリー作品。"
    "メンズエステの施術中に隠しカメラで撮影した映像です。"
    "顔面騎乗位からの本番交渉、盗撮ならではの生々しいメンズエステ体験。"
    "出演はランカー嬢のくらしな。くらしなの匂いに注目。"
    "品番msoc00065、収録時間34分。この作品の監督が贈る渾身の1本。名前は**さん。"
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


def test_dedupes_substring_fragments() -> None:
    keywords = extract_keywords(SAMPLE_DESCRIPTION)
    # 「くらし」は「くらしな」の部分文字列なので、長い方だけが残る。
    assert "くらしな" in keywords
    assert "くらし" not in keywords
    # 出力語のどれも、他の出力語の部分文字列にはなっていない。
    for a in keywords:
        assert not any(a != b and a in b for b in keywords), f"{a} is a substring"


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


# プロフィール行を模したフィクスチャ。janome は '/' と ':' を 名詞,サ変接続 と
# 誤タグ付けするため、旧ロジックでは「/IT系企業勤務/絶頂回数:」のように記号を
# またいで複合語が連結されていた。記号は境界となり、出力語に混入しないことを確認する。
PROFILE_DESCRIPTION = (
    "街中で声をかけた素人。なみさん（28才）/IT系企業勤務/絶頂回数:32回。"
    "るいさん（25才）/ブライダル系企業勤務/絶頂回数:18回。"
    "リモバイを装着したまま黒パンストで歩く姿を盗撮。"
)

# 「というかくらしな」由来の壊れた連結を模したフィクスチャ。janome は
# 「かく(名詞)＋ら(名詞接尾)＋しな(名詞接尾)」と切るため、旧ロジックでは
# 「かくらしな」が生成された。1 文字ひらがな (ら) を連結に含めないことで防ぐ。
HIRAGANA_JOIN_DESCRIPTION = "天然というかくらしなさんの魅力。出演はくらしな。"

# ネットスラングの 'w'(笑) 由来の壊れた連結を模したフィクスチャ。'w' は半角英字で
# _ALLOWED_CHARS を通るため、旧ロジックでは直後の人名に連結され「wくらしな」が
# 生成された (本番 movie h-1832msoc00065 で観測)。1 文字英数字を境界にして防ぐ。
SINGLE_ALNUM_JOIN_DESCRIPTION = (
    "一週間してすぐまた予約をしてしまいましたwくらしなさんにも覚えてもらえた"
)


def test_symbols_are_hard_boundaries() -> None:
    keywords = extract_keywords(PROFILE_DESCRIPTION)
    # 記号 '/' ':' '（' '）' を含む語は 1 つも出力されない。
    assert all("/" not in k for k in keywords)
    assert all(":" not in k for k in keywords)
    assert all("（" not in k and "）" not in k for k in keywords)
    # 記号をまたいだ連結が分割され、内側の語が正しく取れる。
    assert "IT系企業勤務" in keywords
    assert "絶頂回数" in keywords


def test_no_single_char_hiragana_join() -> None:
    keywords = extract_keywords(HIRAGANA_JOIN_DESCRIPTION)
    # 1 文字ひらがな (ら) を巻き込んだ壊れた連結は生成されない。
    assert "かくらしな" not in keywords
    assert all("かくらし" not in k for k in keywords)


def test_no_single_alnum_join() -> None:
    keywords = extract_keywords(SINGLE_ALNUM_JOIN_DESCRIPTION)
    # 'w' を巻き込んだ壊れた連結は生成されず、人名は 'w' 抜きで取れる。
    assert "くらしな" in keywords
    assert "wくらしな" not in keywords
    # 出力語のどれにも単独の 'w' が前後に付いていない。
    assert all(not k.startswith("w") and not k.endswith("w") for k in keywords)
    assert "w" not in keywords


def test_multi_char_latin_still_joins() -> None:
    # 2 文字以上のラテン語は正当な語として連結され続ける (回帰防止)。
    keywords = extract_keywords("街中で声をかけた素人。IT系企業勤務の女性。")
    assert "IT系企業勤務" in keywords


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
