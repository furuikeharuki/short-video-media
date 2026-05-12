import type { MovieCard } from "./feed";

export type SearchResponse = {
  items: MovieCard[];
  total: number;
};

const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000";

export async function searchMovies(query: string): Promise<SearchResponse> {
  const res = await fetch(
    `${API_BASE_URL}/api/v1/search?q=${encodeURIComponent(query)}`,
    { cache: "no-store" }
  );

  if (!res.ok) throw new Error("Failed to search");
  return res.json();
}
