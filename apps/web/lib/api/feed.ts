export type PriceList = {
  list_price: number | null;
  sale_price: number | null;
  rental_price: number | null;
  delivery_price: number | null;
};

export type MovieCard = {
  id: string;
  content_id: string | null;
  title: string;
  slug: string;
  image_url_list: string | null;
  image_url_large: string | null;
  sample_movie_url: string | null;
  affiliate_url: string;
  price_list: PriceList | null;
  price_min: number | null;
  review_count: number;
  review_average: number | null;
  actresses: string[];
  genres: string[];
  series_name: string | null;
};

export type FeedResponse = {
  items: MovieCard[];
  next_cursor: string | null;
  total?: number | null;
};

const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000";

export async function getFeed(
  offset = 0,
  limit = 20,
  seed?: number,
  genres?: string[],
): Promise<FeedResponse> {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
  });
  if (seed !== undefined) params.set("seed", String(seed));
  // genresは複数可能: genres=A&genres=B
  if (genres && genres.length > 0) {
    genres.forEach((g) => params.append("genres", g));
  }

  const res = await fetch(`${API_BASE_URL}/api/v1/feed?${params}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to fetch feed");
  return res.json();
}
