// 作品紹介文の生成 (ルールベース・レンダリング時 / DB 保存なし)。
//
// 構造化メタデータ (女優・ジャンル・品番・レーベル・収録時間・価格・配信日) だけから
// 決定的に 1 段落の紹介文を組み立てる。LLM も正規表現による文中パターン抽出も使わない。
//
// 薄い重複コンテンツ対策として、slug のハッシュで 4 つの文型から 1 つを決定的に選ぶ
// (全ページ同一文を避ける / 同一 slug は常に同じ文)。欠損データがあっても
// 文が破綻しないよう、各断片は空になり得る前提で組み立てる。

import { formatHinban, formatJpDate } from "./movieSpec";

const SITE_NAME = "AV Shorts";

export type MovieIntroInput = {
  title: string;
  slug: string;
  actresses: string[];
  genres: string[];
  product_id: string | null;
  maker_product: string | null;
  label_name: string | null;
  maker_name: string | null;
  volume: number | null;
  price_min: number | null;
  price_list: {
    list_price: number | null;
    sale_price: number | null;
  } | null;
  delivery_date: string | null;
  release_date: string | null;
  primary_date: string | null;
};

/** FNV-1a 32bit。slug から決定的な非負整数を得る (テンプレ選択用)。 */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 出演女優の句。0名は空、1名は「name」、2-3名は列挙、4名以上は総勢N名。 */
function actressPhrase(actresses: string[]): string {
  const names = actresses.filter((n) => n && n.trim());
  if (names.length === 0) return "";
  if (names.length === 1) return `「${names[0]}」`;
  if (names.length <= 3) return names.map((n) => `「${n}」`).join("");
  return `総勢${names.length}名`;
}

/** ジャンル由来の作品タイプ句。上位 1-2 ジャンルを使う。無ければ「作品」。 */
function genrePhrase(genres: string[]): string {
  const gs = genres.filter((g) => g && g.trim()).slice(0, 2);
  if (gs.length === 0) return "作品";
  return `${gs.join("・")}作品`;
}

/** メーカー/レーベル句 (「〜による」)。無ければ空。 */
function makerLabelPhrase(input: MovieIntroInput): string {
  if (input.label_name) return `${input.label_name}レーベルによる`;
  if (input.maker_name) return `${input.maker_name}による`;
  return "";
}

function volumePhrase(volume: number | null): string {
  return volume != null ? `収録${volume}分の` : "";
}

function displayPrice(input: MovieIntroInput): number | null {
  return (
    input.price_list?.sale_price ??
    input.price_list?.list_price ??
    input.price_min ??
    null
  );
}

/** 「続きはFANZAで◯◯円から」。価格が無ければ汎用 CTA。 */
function pricePhrase(input: MovieIntroInput): string {
  const price = displayPrice(input);
  if (price != null) return `続きはFANZAで${price.toLocaleString()}円から`;
  return "続きはFANZAでチェック";
}

/** 配信日 (配信→primary→発売の順で採用)。無ければ空。 */
function deliveryDatePhrase(input: MovieIntroInput): string {
  const d =
    formatJpDate(input.delivery_date) ??
    formatJpDate(input.primary_date) ??
    formatJpDate(input.release_date);
  return d ? `${d}配信開始` : "";
}

/** 空断片を除いて「。」で連結し、末尾に句点を付ける。 */
function joinSentences(sentences: string[]): string {
  const body = sentences
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("。");
  if (!body) return "";
  return body.endsWith("。") ? body : `${body}。`;
}

type Parts = {
  actress: string; // 「name」 or 総勢N名 or ''
  genre: string; // 〜作品
  hinban: string; // 品番 (整形済み) or ''
  makerLabel: string; // 〜による or ''
  volume: string; // 収録N分の or ''
  cta: string; // 定型 CTA 文
  price: string; // 続きはFANZAで...
  date: string; // 配信開始 or ''
};

// slug ハッシュで選ぶ文型 (4 パターン)。各テンプレは Parts の欠損に耐える。
const TEMPLATES: ((p: Parts) => string)[] = [
  // 0: spec 例に近い型
  (p) =>
    joinSentences([
      `${p.actress ? `${p.actress}出演の` : ""}${p.genre}${p.hinban ? `(品番: ${p.hinban})` : ""}`,
      `${p.makerLabel}${p.volume}作品です`,
      p.cta,
      `${p.price}${p.date ? `(${p.date})` : ""}`,
    ]),
  // 1: メーカー/レーベルを主語に前置
  (p) =>
    joinSentences([
      `${p.makerLabel ? p.makerLabel : ""}${p.genre}${p.actress ? `に${p.actress}が出演` : ""}`,
      `${p.volume ? `${p.volume}ボリューム。` : ""}${p.hinban ? `品番は${p.hinban}` : ""}`.replace(/。$/, ""),
      p.cta,
      `${p.price}${p.date ? `(${p.date})` : ""}`,
    ]),
  // 2: 女優 → 見どころ → CTA の順
  (p) =>
    joinSentences([
      `${p.actress ? `${p.actress}が魅せる` : "注目の"}${p.genre}`,
      `${p.volume}${p.makerLabel}話題作${p.hinban ? `(${p.hinban})` : ""}`,
      p.cta,
      `${p.price}${p.date ? `(${p.date}〜)` : ""}`,
    ]),
  // 3: シンプル一文型 + CTA
  (p) =>
    joinSentences([
      `${p.actress ? `${p.actress}出演。` : ""}${p.makerLabel}${p.volume}${p.genre}${p.hinban ? `(品番: ${p.hinban})` : ""}`.replace(
        /^。/,
        "",
      ),
      `${p.cta}し、${p.price}${p.date ? `(${p.date})` : ""}`,
    ]),
];

/**
 * 作品紹介文を生成する。データが乏しくても最低限 CTA を含む文を返す。
 * 同一 slug では常に同じ文型・同じ文を返す (決定的)。
 */
export function generateIntro(input: MovieIntroInput): string {
  const parts: Parts = {
    actress: actressPhrase(input.actresses),
    genre: genrePhrase(input.genres),
    hinban: formatHinban(input.product_id, input.maker_product),
    makerLabel: makerLabelPhrase(input),
    volume: volumePhrase(input.volume),
    cta: `${SITE_NAME}ならクライマックスをショート動画で今すぐ試し見`,
    price: pricePhrase(input),
    date: deliveryDatePhrase(input),
  };

  const idx = hashString(input.slug) % TEMPLATES.length;
  const text = TEMPLATES[idx](parts);
  // 念のための後始末: 連続句点や余分な区切りを畳む。
  return text
    .replace(/。+/g, "。")
    .replace(/・+/g, "・")
    .replace(/\(\)/g, "")
    .trim();
}

/** テスト/デバッグ用: slug から選ばれるテンプレ番号。 */
export function templateIndexForSlug(slug: string): number {
  return hashString(slug) % TEMPLATES.length;
}

export const INTRO_TEMPLATE_COUNT = TEMPLATES.length;
