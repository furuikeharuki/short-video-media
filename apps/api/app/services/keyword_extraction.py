"""dmm_description (FANZA 公式説明文) からの特徴語抽出。

方針 (ユーザー明示指示):
  - LLM は使わない。正規表現による文中パターン抽出 (「N回目」「◯◯コース」等) も使わない。
  - janome による形態素解析で名詞を取り出し、頻度 + ストップワードでスコアリングする
    ルールベースのみ。

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

# 対象とする名詞の細分類。spec の「名詞(一般・固有)」に、ドメイン上有用な
# サ変接続 (例: 潜入・調教・撮影 などの動作性名詞) を加える。数・接尾・非自立・
# 代名詞などは除外することでノイズを抑える。
_NOUN_SUBTYPES = frozenset({"一般", "固有名詞", "サ変接続"})

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


def _is_candidate(surface: str, part_of_speech: str) -> bool:
    parts = part_of_speech.split(",")
    if not parts or parts[0] != "名詞":
        return False
    subtype = parts[1] if len(parts) > 1 else ""
    if subtype not in _NOUN_SUBTYPES:
        return False
    surface = surface.strip()
    if len(surface) < 2:  # 1 文字語は除外
        return False
    if surface.isdigit():  # 数字のみは除外
        return False
    if "*" in surface or "＊" in surface:  # 伏字 (**) は除外
        return False
    if not _HAS_JP.search(surface):  # 日本語を含まない語 (記号・ラテン等) は除外
        return False
    if surface in STOPWORDS:
        return False
    return True


def extract_keywords(text: str | None, *, max_keywords: int = 8) -> list[str]:
    """作品説明文から特徴語を最大 ``max_keywords`` 個抽出する。

    - 形態素解析で名詞 (一般・固有名詞・サ変接続) を取り出す。
    - 1 文字語・数字のみ・記号のみ・伏字 (``*`` を含む語)・ストップワードを除外。
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
        for token in tokenizer.tokenize(text):
            surface = token.surface.strip()
            if _is_candidate(surface, token.part_of_speech):
                counts[surface] = counts.get(surface, 0) + 1
    except Exception:  # noqa: BLE001
        logger.warning("キーワード抽出中にエラーが発生しました。", exc_info=True)
        return []

    # 頻度降順 → 初出順 (dict は挿入順を保持するため、安定ソートで初出順が保たれる)。
    ordered = sorted(counts.items(), key=lambda kv: -kv[1])
    return [word for word, _ in ordered[:max_keywords]]
