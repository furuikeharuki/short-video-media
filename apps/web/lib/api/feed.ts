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

/** /feed エンドポイントに渡せる詳細フィルター (検索結果と同名でそろえる)。 */
export type FeedAdvancedParams = {
  q?: string;
  actresses?: string[];
  series_list?: string[];
  directors?: string[];
  makers?: string[];
  labels?: string[];
  ng_words?: string[];
  date_from?: string;
  date_to?: string;
  /** 並び替え。未指定 (空文字 / undefined) なら従来通り shuffle 順。 */
  sort?: string;
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
  advanced?: FeedAdvancedParams,
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

  if (advanced) {
    const appendMulti = (key: string, arr: string[] | undefined) => {
      if (!arr) return;
      for (const v of arr) {
        const t = v.trim();
        if (t) params.append(key, t);
      }
    };
    if (advanced.q && advanced.q.trim()) params.set("q", advanced.q.trim());
    appendMulti("actresses", advanced.actresses);
    appendMulti("series_list", advanced.series_list);
    appendMulti("directors", advanced.directors);
    appendMulti("makers", advanced.makers);
    appendMulti("labels", advanced.labels);
    appendMulti("ng_words", advanced.ng_words);
    if (advanced.date_from && advanced.date_from.trim()) {
      params.set("date_from", advanced.date_from.trim());
    }
    if (advanced.date_to && advanced.date_to.trim()) {
      params.set("date_to", advanced.date_to.trim());
    }
    if (advanced.sort && advanced.sort.trim()) {
      params.set("sort", advanced.sort.trim());
    }
  }

  const res = await fetch(`${API_BASE_URL}/api/v1/feed?${params}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to fetch feed");
  return res.json();
}
