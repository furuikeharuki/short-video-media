import { cache } from "react";

import type { MovieCard } from "./feed";

// 作品詳細ページの「関連作品」セクション用データ取得。
//
// 既存の advanced search エンドポイント (/api/v1/search) をそのまま再利用するため
// API 側の変更は不要。作品詳細と同じ 1 時間 ISR でキャッシュし、
// クローラー / 初期表示の負荷を抑える。React.cache で同一リクエスト内の
// 二重 fetch を 1 回にまとめる。

const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000";

type SearchParam = { key: string; value: string };

async function fetchRelated(
  params: SearchParam[],
  sort: string,
  limit: number,
): Promise<MovieCard[]> {
  const sp = new URLSearchParams();
  for (const { key, value } of params) sp.append(key, value);
  sp.set("sort", sort);
  sp.set("offset", "0");
  sp.set("limit", String(limit));

  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/search?${sp}`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: MovieCard[] };
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

/** 同じ女優の他作品 (人気順)。currentSlug は除外する。 */
export const getMoviesByActress = cache(
  async (actress: string, currentSlug: string, limit = 12): Promise<MovieCard[]> => {
    const items = await fetchRelated([{ key: "actresses", value: actress }], "popular", limit + 1);
    return items.filter((m) => m.slug !== currentSlug).slice(0, limit);
  },
);

/** 同じシリーズの作品 (新作順)。currentSlug は除外する。 */
export const getMoviesBySeries = cache(
  async (series: string, currentSlug: string, limit = 12): Promise<MovieCard[]> => {
    const items = await fetchRelated([{ key: "series_list", value: series }], "new", limit + 1);
    return items.filter((m) => m.slug !== currentSlug).slice(0, limit);
  },
);

/** 同じジャンルの人気作 (人気順)。currentSlug は除外する。 */
export const getMoviesByGenre = cache(
  async (genre: string, currentSlug: string, limit = 12): Promise<MovieCard[]> => {
    const items = await fetchRelated([{ key: "genres", value: genre }], "popular", limit + 1);
    return items.filter((m) => m.slug !== currentSlug).slice(0, limit);
  },
);
