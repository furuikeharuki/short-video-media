/**
 * ホームのセクションを offset / limit でページングして取得するクライアント。
 * /api/v1/home/section に対応。
 *
 * key:
 *   - "popular" / "new" / "recent"
 *   - "ranking_daily" / "ranking_weekly" / "ranking_monthly"
 *   - "genre" (genre パラメータ必須)
 */
import type { FeedResponse } from "./feed";

const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000";

export type HomeSectionKey =
  | "popular"
  | "popular_products"
  | "new"
  | "recent"
  | "ranking_daily"
  | "ranking_weekly"
  | "ranking_monthly"
  | "genre";

export async function getHomeSection(
  key: HomeSectionKey,
  offset = 0,
  limit = 20,
  genre?: string,
): Promise<FeedResponse> {
  const params = new URLSearchParams({
    key,
    offset: String(offset),
    limit: String(limit),
  });
  if (genre) params.set("genre", genre);

  const res = await fetch(`${API_BASE_URL}/api/v1/home/section?${params}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to fetch home section");
  return res.json();
}
