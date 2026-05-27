/**
 * 詳細検索パネル (GlobalFilterButton) が sessionStorage に保存している
 * 「直近の詳細検索条件」を読み出すための共有ヘルパー。
 *
 * - SESSION_KEY と StoredPref は GlobalFilterButton / useEnforceSavedFilter と同形。
 * - 形が同じでも別ファイルでロジックが微妙にずれる (sort バリデーション漏れなど) と
 *   ショートボタン経由と feed 内部 fallback で挙動が割れるので、ここに一本化する。
 */
export const SAVED_SEARCH_PREFS_KEY = "search_prefs_v1";

const VALID_SORTS = new Set(["new", "popular", "rating", "views", "bookmarks"]);

export type SavedSearchPref = {
  q?: string;
  genres?: string[];
  actresses?: string[];
  series_list?: string[];
  directors?: string[];
  makers?: string[];
  labels?: string[];
  ng_words?: string[];
  date_from?: string;
  date_to?: string;
  sort?: string;
};

function cleanArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const s of v) {
    if (typeof s !== "string") continue;
    const t = s.trim();
    if (t) out.push(t);
  }
  return out;
}

function cleanString(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim();
}

/**
 * sessionStorage から保存済み詳細検索条件を読み、トリミング済みの形で返す。
 * 何も保存されていない / 壊れている / 全項目空 のときは null。
 */
export function readSavedSearchPref(): SavedSearchPref | null {
  if (typeof window === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(SAVED_SEARCH_PREFS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;

  const cleaned: SavedSearchPref = {};
  const q = cleanString(p.q);
  if (q) cleaned.q = q;
  const genres = cleanArray(p.genres);
  if (genres.length) cleaned.genres = genres;
  const actresses = cleanArray(p.actresses);
  if (actresses.length) cleaned.actresses = actresses;
  const series_list = cleanArray(p.series_list);
  if (series_list.length) cleaned.series_list = series_list;
  const directors = cleanArray(p.directors);
  if (directors.length) cleaned.directors = directors;
  const makers = cleanArray(p.makers);
  if (makers.length) cleaned.makers = makers;
  const labels = cleanArray(p.labels);
  if (labels.length) cleaned.labels = labels;
  const ng_words = cleanArray(p.ng_words);
  if (ng_words.length) cleaned.ng_words = ng_words;
  const date_from = cleanString(p.date_from);
  if (date_from) cleaned.date_from = date_from;
  const date_to = cleanString(p.date_to);
  if (date_to) cleaned.date_to = date_to;
  const sort = cleanString(p.sort);
  if (sort && VALID_SORTS.has(sort)) cleaned.sort = sort;

  // 全部空なら null。
  if (
    !cleaned.q &&
    !cleaned.genres &&
    !cleaned.actresses &&
    !cleaned.series_list &&
    !cleaned.directors &&
    !cleaned.makers &&
    !cleaned.labels &&
    !cleaned.ng_words &&
    !cleaned.date_from &&
    !cleaned.date_to &&
    !cleaned.sort
  ) {
    return null;
  }
  return cleaned;
}

/** 保存済み詳細条件を /feed?... の URL クエリ文字列に展開する。
 *  保存無し / 全部空のときは "/feed" を返す (従来挙動と同じ)。 */
export function buildFeedHrefFromSavedPref(): string {
  const pref = readSavedSearchPref();
  if (!pref) return "/feed";
  const params = new URLSearchParams();
  if (pref.q) params.set("q", pref.q);
  const appendMulti = (key: string, arr: string[] | undefined) => {
    if (!arr) return;
    for (const v of arr) params.append(key, v);
  };
  appendMulti("genres", pref.genres);
  appendMulti("actresses", pref.actresses);
  appendMulti("series_list", pref.series_list);
  appendMulti("directors", pref.directors);
  appendMulti("makers", pref.makers);
  appendMulti("labels", pref.labels);
  appendMulti("ng_words", pref.ng_words);
  if (pref.date_from) params.set("date_from", pref.date_from);
  if (pref.date_to) params.set("date_to", pref.date_to);
  if (pref.sort) params.set("sort", pref.sort);
  const qs = params.toString();
  return qs ? `/feed?${qs}` : "/feed";
}
