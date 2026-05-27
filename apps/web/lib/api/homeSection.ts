/**
 * ホームのセクションを offset / limit でページングして取得するクライアント。
 * /api/v1/home/section に対応。
 *
 * key:
 *   - "popular" / "new" / "recent"
 *   - "ranking_daily" / "ranking_weekly" / "ranking_monthly"
 *   - "genre" (genre パラメータ必須)
 *   - "popular_products" は GoodsCard を返す専用エンドポイントを使う
 *     (getPopularProductsSection 参照)。
 */
import type { FeedResponse } from "./feed";
import type { GoodsCard } from "./home";

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

/** 動画系 (MovieCard) セクション用。popular_products はここでは扱えない。 */
export type MovieSectionKey = Exclude<HomeSectionKey, "popular_products">;

export async function getHomeSection(
  key: MovieSectionKey,
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

export type GoodsFeedResponse = {
  items: GoodsCard[];
  next_cursor: string | null;
};

/**
 * 人気商品 (Goods) セクションをページングして取得するクライアント。
 * MovieCard 系セクションと型が違うので専用エンドポイント / 関数を分けている。
 */
export async function getPopularProductsSection(
  offset = 0,
  limit = 20,
): Promise<GoodsFeedResponse> {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
  });
  const res = await fetch(
    `${API_BASE_URL}/api/v1/home/section/popular_products?${params}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error("Failed to fetch popular products");
  return res.json();
}
