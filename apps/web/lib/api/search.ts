import type { MovieCard } from "./feed";

export type SearchResponse = {
  items: MovieCard[];
  total: number;
  /** 次ページの offset (文字列)。末尾に達したら null。 */
  next_cursor: string | null;
};

const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000";

/** キーワード部分一致検索 (offset / limit ページング対応)。 */
export async function searchMovies(
  query: string,
  offset = 0,
  limit = 20,
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    q: query,
    offset: String(offset),
    limit: String(limit),
  });
  const res = await fetch(
    `${API_BASE_URL}/api/v1/search?${params}`,
    { cache: "no-store" }
  );

  if (!res.ok) throw new Error("Failed to search");
  return res.json();
}

export type ExactField = "director" | "maker" | "label" | "series";

/** 監督 / メーカー / レーベル / シリーズの完全一致検索 (offset / limit ページング対応)。 */
export async function searchMoviesByExactField(
  field: ExactField,
  value: string,
  offset = 0,
  limit = 20,
): Promise<SearchResponse> {
  const params = new URLSearchParams({
    [field]: value,
    offset: String(offset),
    limit: String(limit),
  });
  const res = await fetch(
    `${API_BASE_URL}/api/v1/search?${params}`,
    { cache: "no-store" }
  );
  if (!res.ok) throw new Error("Failed to search");
  return res.json();
}

// 詳細検索 (advanced search) 用のソートキー。API 側と揃える。
export type SortKey = "new" | "popular" | "rating" | "views" | "bookmarks";

/**
 * 詳細検索の入力パラメータ。
 * いずれも optional。すべて undefined / 空配列だと全件検索に近い振る舞いになるため、
 * 呼び出し側は「何も指定しない」ケースをガードすること。
 */
export type AdvancedSearchInput = {
  q?: string;
  /** 複数ジャンル (AND) */
  genres?: string[];
  /** 複数女優 (AND) */
  actresses?: string[];
  /** 複数シリーズ名 (OR) */
  series_list?: string[];
  /** 複数監督名 (OR) */
  directors?: string[];
  /** 複数メーカー名 (OR) */
  makers?: string[];
  /** 複数レーベル名 (OR) */
  labels?: string[];
  /** 配信日 >= (YYYY-MM-DD) */
  date_from?: string;
  /** 配信日 <= (YYYY-MM-DD) */
  date_to?: string;
  /** ソートキー */
  sort?: SortKey;
  /**
   * NG ワード。クエリに乗せるとサーバ保存より優先される。
   * 未ログインユーザーはここに乗せることで「その検索だけ」適用できる。
   */
  ng_words?: string[];
};

/**
 * 詳細検索。それぞれの複数フィールドは `genres=A&genres=B` の形で送る。
 */
export async function advancedSearch(
  input: AdvancedSearchInput,
  offset = 0,
  limit = 20,
): Promise<SearchResponse> {
  const params = buildAdvancedSearchParams(input);
  params.set("offset", String(offset));
  params.set("limit", String(limit));
  const res = await fetch(`${API_BASE_URL}/api/v1/search?${params}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to search");
  return res.json();
}

/**
 * AdvancedSearchInput を URLSearchParams にシリアライズする。
 * URL 同期 (ShareableURL) と fetch 両方で使うため共通関数にしている。
 */
export function buildAdvancedSearchParams(
  input: AdvancedSearchInput,
): URLSearchParams {
  const p = new URLSearchParams();
  if (input.q?.trim()) p.set("q", input.q.trim());
  const multi: [keyof AdvancedSearchInput, string][] = [
    ["genres", "genres"],
    ["actresses", "actresses"],
    ["series_list", "series_list"],
    ["directors", "directors"],
    ["makers", "makers"],
    ["labels", "labels"],
    ["ng_words", "ng_words"],
  ];
  for (const [key, paramName] of multi) {
    const arr = input[key] as string[] | undefined;
    if (arr && arr.length > 0) {
      // 重複と空文字を除去
      const dedup = Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
      for (const v of dedup) p.append(paramName, v);
    }
  }
  if (input.date_from) p.set("date_from", input.date_from);
  if (input.date_to) p.set("date_to", input.date_to);
  if (input.sort) p.set("sort", input.sort);
  return p;
}

export type SuggestField =
  | "actress"
  | "series"
  | "director"
  | "maker"
  | "label"
  | "genre";

/**
 * 詳細検索パネルの入力補助サジェスト。
 * 使用頻度 (その値を持つ作品数) 順で上位 limit 件を返す。
 */
export async function suggestFieldValues(
  field: SuggestField,
  q: string,
  limit = 10,
): Promise<string[]> {
  const params = new URLSearchParams({
    field,
    q,
    limit: String(limit),
  });
  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/search/suggest?${params}`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { items: string[] };
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}
