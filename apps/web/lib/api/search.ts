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
