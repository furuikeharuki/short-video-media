export type MovieDetail = {
  id: string;
  content_id: string | null;
  title: string;
  slug: string;
  description: string;
  image_url_list: string | null;
  image_url_large: string | null;
  sample_movie_url: string | null;
  sample_embed_url: string | null;
  affiliate_url: string;
  price_list: {
    list_price: number | null;
    sale_price: number | null;
    rental_price: number | null;
    delivery_price: number | null;
  } | null;
  price_min: number | null;
  review_count: number;
  review_average: number | null;
  actresses: string[];
  genres: string[];
  series_name: string | null;
  // 追加フィールド
  delivery_date: string | null;
  release_date: string | null;
  duration: number | null;       // 収録時間（分）
  director: string | null;
  maker: string | null;
  label: string | null;
};

const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000";

export async function getMovieBySlug(slug: string): Promise<MovieDetail> {
  const res = await fetch(`${API_BASE_URL}/api/v1/movies/${slug}`, {
    cache: "no-store",
  });

  if (res.status === 404) {
    throw new Error("NOT_FOUND");
  }

  if (!res.ok) {
    throw new Error("Failed to fetch movie detail");
  }

  return res.json();
}
