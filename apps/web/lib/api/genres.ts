import { cache } from "react";

import type { MovieCard } from "./feed";

export type GenreMoviesResult = {
  items: MovieCard[];
  total: number;
};

const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000";

/**
 * ジャンル集約ページ (/genres/[genre]) 用の初期表示作品を取得する。
 *
 * 既存の advanced search エンドポイント (genres=AND) をそのまま利用するため、
 * API 側の変更は不要。ISR で 1 時間キャッシュし、クローラ/初期表示の負荷を抑える。
 * React.cache で generateMetadata と page の二重 fetch を 1 回にまとめる。
 */
export const getGenreMovies = cache(
  async (genre: string, limit = 30): Promise<GenreMoviesResult> => {
    const params = new URLSearchParams();
    params.append("genres", genre);
    params.set("sort", "new");
    params.set("offset", "0");
    params.set("limit", String(limit));

    const res = await fetch(`${API_BASE_URL}/api/v1/search?${params}`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) {
      throw new Error("Failed to fetch genre movies");
    }
    const data = (await res.json()) as {
      items: MovieCard[];
      total: number;
      next_cursor: string | null;
    };
    return { items: data.items ?? [], total: data.total ?? 0 };
  },
);
