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
import type { ActressCard, GoodsCard } from "./home";

const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000";

export type HomeSectionKey =
  | "popular"
  | "popular_products"
  | "popular_actresses"
  | "new"
  | "recent"
  | "ranking_daily"
  | "ranking_weekly"
  | "ranking_monthly"
  | "genre";

/** 動画系 (MovieCard) セクション用。popular_products / popular_actresses はここでは扱えない。 */
export type MovieSectionKey = Exclude<
  HomeSectionKey,
  "popular_products" | "popular_actresses"
>;

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

/**
 * SSR で「クロール用の内部リンク種」を取りにいくための軽量フェッチ。
 * 通常の getHomeSection は cache:"no-store" でクライアント無限スクロール用だが、
 * これは server component から呼び、Next のデータキャッシュ (revalidate) に載せて
 * 毎リクエストの API ラウンドトリップを避ける。失敗時は空配列を返して描画を妨げない。
 * 取得した items は画面の見た目には使わず、視覚的に隠した <a> リンクとして出力する
 * (クライアントの列数依存グリッドはこれまで通りクライアントが別途取得する)。
 */
export async function getHomeSectionSeed(
  key: MovieSectionKey,
  limit = 24,
  genre?: string,
): Promise<MovieCardSeed[]> {
  const params = new URLSearchParams({
    key,
    offset: "0",
    limit: String(limit),
  });
  if (genre) params.set("genre", genre);
  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/home/section?${params}`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as FeedResponse;
    return data.items.map((i) => ({ slug: i.slug, title: i.title }));
  } catch {
    return [];
  }
}

export type MovieCardSeed = { slug: string; title: string };

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

export type ActressFeedResponse = {
  items: ActressCard[];
  next_cursor: string | null;
};

/**
 * 人気女優 (Actress) セクションをページングして取得するクライアント。
 * MovieCard 系セクションと型が違うので専用エンドポイント / 関数を分けている。
 */
export async function getPopularActressesSection(
  offset = 0,
  limit = 20,
): Promise<ActressFeedResponse> {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
  });
  const res = await fetch(
    `${API_BASE_URL}/api/v1/home/section/popular_actresses?${params}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error("Failed to fetch popular actresses");
  return res.json();
}
