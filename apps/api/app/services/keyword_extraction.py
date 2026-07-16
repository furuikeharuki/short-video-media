"""dmm_description (FANZA 公式説明文) からの特徴語抽出。

方針 (ユーザー明示指示):
  - LLM は使わない。正規表現による文中パターン抽出 (「N回目」「◯◯コース」等) も使わない。
  - janome による形態素解析で名詞を取り出し、頻度 + ストップワードでスコアリングする
    ルールベースのみ。
  - IPADIC は複合語を細切れにする (「メンズエステ」→「メンズ」+「エステ」、
    「顔面騎乗位」→「顔面」+「騎乗」+「位」)。そのままだと壊れた断片が並ぶため、
    連続する名詞トークンを 1 語に連結してから採点する。連結後の語を採用するので、
    複合語の内部にしか現れない断片 (「メンズ」単体等) は個別には出力されない。

抽出した特徴語は詳細ページ / モーダルの「この作品のキーワード」チップに使う。
薄い重複コンテンツ対策として作品ごとに異なる語彙を SSR HTML に出すのが狙い。

janome は純 Python 依存なので本番 API イメージにも同梱できる。万一 import に
失敗しても (依存欠落等) 抽出は空リストを返し、呼び出し側の処理は継続させる。
"""
from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

# ひらがな・カタカナ・漢字・長音のいずれかを 1 文字でも含むか。
# 純粋に数字/記号/ラテン文字だけの語 (ノイズになりやすい) を落とすために使う。
_HAS_JP = re.compile(r"[぀-ヿ㐀-鿿豈-﫿ー]")

# 全体がひらがな (+ 長音) のみで構成されるか。短いひらがな語は助詞・助動詞由来の
# 断片や人名 (くらしなひまり→「くら」等) の切れ端であることが多く、特徴語にならない。
_HIRAGANA_ONLY = re.compile(r"^[぀-ゟー]+$")

# 複合語連結に取り込む名詞の細分類。「名詞(一般・固有)」+ 動作性の
# サ変接続 (潜入・騎乗・交渉 等) + 接尾 (位・店・嬢 等) を対象にする。
# 接尾は複合語の途中/末尾でのみ有効で、単独では語を開始させない (下の連結処理参照)。
_NOUN_SUBTYPES = frozenset({"一般", "固有名詞", "サ変接続", "接尾"})

# 名詞・接尾に分類されるが、人名等に付くだけで意味のある複合語を作らない敬称・愛称。
# 連結すると「くらちゃん」のような人名断片が生まれるため、連結の境界として扱う。
_HONORIFIC_SUFFIXES = frozenset(
    {"ちゃん", "さん", "くん", "君", "様", "さま", "たん", "ちゃま", "氏"}
)

# ドメイン汎用語のストップワード。どの作品説明にも現れて特徴にならない語や、
# サイト・販売文脈の定型語を除外する。実データを見ながら随時充実させる。
STOPWORDS: frozenset[str] = frozenset(
    {
        # 制作・メディア一般
        "監督", "作品", "動画", "映像", "本編", "サンプル", "収録", "撮影",
        "画像", "写真", "シーン", "カット", "スタジオ", "カメラ",
        # サイト・販売文脈
        "配信", "販売", "購入", "視聴", "再生", "無料", "公式", "詳細",
        "情報", "紹介", "登場", "内容", "商品", "価格", "特典", "限定",
        "話題", "人気", "注目", "最新", "今回", "今度", "以上", "以下",
        "場合", "可能", "予定", "全部", "全て", "すべて", "一部", "多数",
        # 汎用的すぎる人・体・様子の語
        "風俗", "女の子", "感じ", "気持", "様子", "自分", "彼女", "相手",
        "女性", "男性", "素人", "本物", "普通", "最高", "最強", "抜群",
        "存在", "世界", "時間", "瞬間", "経験", "体験", "気分",
    }
)


class _TokenizerHolder:
    """janome Tokenizer をプロセスで 1 つだけ遅延生成して使い回す。

    Tokenizer の初期化 (辞書ロード) は数百 ms かかるため、毎回作らない。
    import 失敗時は None を保持し、以降 extract_keywords は空リストを返す。
    """

    _initialized = False
    _tokenizer = None

    @classmethod
    def get(cls):
        if not cls._initialized:
            cls._initialized = True
            try:
                from janome.tokenizer import Tokenizer

                cls._tokenizer = Tokenizer()
            except Exception:  # noqa: BLE001
                logger.warning(
                    "janome の初期化に失敗しました。キーワード抽出は無効化されます。",
                    exc_info=True,
                )
                cls._tokenizer = None
        return cls._tokenizer


def _is_compound_part(surface: str, part_of_speech: str) -> tuple[bool, str]:
    """トークンが複合語連結の対象名詞かを判定し、(可否, 細分類) を返す。

    数・非自立・代名詞・敬称や、ストップワード・伏字を含むトークンは連結対象外。
    これらは連結の境界となり、それ自体は語に取り込まれない。
    """
    parts = part_of_speech.split(",")
    if not parts or parts[0] != "名詞":
        return False, ""
    subtype = parts[1] if len(parts) > 1 else ""
    if subtype not in _NOUN_SUBTYPES:
        return False, subtype
    surface = surface.strip()
    if not surface:
        return False, subtype
    if surface in _HONORIFIC_SUFFIXES:  # 敬称・愛称は境界扱い (人名断片を作らない)
        return False, subtype
    if surface in STOPWORDS:  # 汎用語は複合語に取り込まない (境界)
        return False, subtype
    if "*" in surface or "＊" in surface:  # 伏字を含むトークンは境界
        return False, subtype
    return True, subtype


def _accept_term(term: str) -> bool:
    """連結後の語を特徴語として採用するかの最終フィルタ。"""
    if len(term) < 2:  # 1 文字語は除外
        return False
    if term.isdigit():  # 数字のみは除外
        return False
    if "*" in term or "＊" in term:  # 伏字 (**) は除外
        return False
    if not _HAS_JP.search(term):  # 日本語を含まない語 (記号・ラテン等) は除外
        return False
    if _HIRAGANA_ONLY.match(term) and len(term) <= 2:
        return False  # 2 文字以下のひらがな断片 (人名・助詞由来) は除外
    if term in STOPWORDS:
        return False
    return True


def _compound_terms(tokenizer, text: str) -> list[str]:
    """連続する名詞トークンを 1 語に連結した複合語の列を出現順に返す。

    接尾は語頭にはなれない (先頭に来た接尾は読み飛ばす)。敬称・ストップワード・
    非名詞は連結の境界となる。連結後の語は ``_accept_term`` で最終フィルタする。
    """
    terms: list[str] = []
    run: list[str] = []

    def flush() -> None:
        if run:
            term = "".join(run)
            if _accept_term(term):
                terms.append(term)
            run.clear()

    for token in tokenizer.tokenize(text):
        surface = token.surface.strip()
        ok, subtype = _is_compound_part(surface, token.part_of_speech)
        if ok:
            if not run and subtype == "接尾":
                continue  # 接尾単独では語を開始しない
            run.append(surface)
        else:
            flush()
    flush()
    return terms


def _dedupe_substrings(counts: dict[str, int]) -> list[tuple[str, int]]:
    """他の語の部分文字列になっている語を落とし、長い語に統合する。

    「くらし」が「くらしな」の部分文字列のように、同じ語幹の断片が重複するのを防ぐ。
    短い語は、それを含む最長の語 (同長なら高頻度→初出順) にスコアを加算してから
    除外する。残った語を統合後スコアの降順・初出順で並べて返す。
    """
    terms = list(counts.keys())  # 初出順 (dict は挿入順を保持)
    order = {t: i for i, t in enumerate(terms)}
    merged = dict(counts)
    absorbed: set[str] = set()

    for t in terms:
        absorbers = [
            u for u in terms if u != t and len(u) > len(t) and t in u
        ]
        if not absorbers:
            continue
        # 最長 → 高頻度 → 初出 (最小 order) を吸収先に選ぶ (決定的)。
        best = max(absorbers, key=lambda u: (len(u), counts[u], -order[u]))
        merged[best] += counts[t]
        absorbed.add(t)

    remaining = [(t, merged[t]) for t in terms if t not in absorbed]
    remaining.sort(key=lambda kv: (-kv[1], order[kv[0]]))
    return remaining


def extract_keywords(text: str | None, *, max_keywords: int = 8) -> list[str]:
    """作品説明文から特徴語を最大 ``max_keywords`` 個抽出する。

    - 形態素解析で名詞 (一般・固有名詞・サ変接続・接尾) を取り出し、連続する名詞を
      1 語に連結する (「メンズ」+「エステ」→「メンズエステ」、
      「顔面」+「騎乗」+「位」→「顔面騎乗位」)。連結後の語のみを採点するため、
      複合語の内部にしか現れない断片は個別に出力されない。
    - 連結後に、2 文字未満・数字のみ・記号のみ・伏字 (``*`` を含む語)・
      2 文字以下のひらがな断片・ストップワードを除外する。
    - 別の語の部分文字列になっている語 (「くらし」⊂「くらしな」等) は、長い語に
      スコアを統合したうえで除外する (top-N 切り出しの前に行い、リストを埋める)。
    - 文書内頻度の降順で並べ、同数は初出順 (決定的) で採用する。
    - 空文字 / None / janome 利用不可のときは空リストを返す。
    """
    if not text or not text.strip():
        return []
    tokenizer = _TokenizerHolder.get()
    if tokenizer is None:
        return []

    counts: dict[str, int] = {}
    try:
        for term in _compound_terms(tokenizer, text):
            counts[term] = counts.get(term, 0) + 1
    except Exception:  # noqa: BLE001
        logger.warning("キーワード抽出中にエラーが発生しました。", exc_info=True)
        return []

    # 部分文字列の重複を統合・除外してから上位 N 件を切り出す。
    ordered = _dedupe_substrings(counts)
    return [word for word, _ in ordered[:max_keywords]]
