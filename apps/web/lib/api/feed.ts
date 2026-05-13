export type MovieCard = {
  id: string;
  title: string;
  slug: string;
  thumbnail_url: string;
  sample_video_url?: string | null;
  sample_embed_url: string;
  actresses: string[];
  genres: string[];
  affiliate_url: string;
};

export type FeedResponse = {
  items: MovieCard[];
  next_cursor: string | null;
};

const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000";

export async function getFeed(
  offset = 0,
  limit = 20,
  seed?: number,
): Promise<FeedResponse> {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
  });
  if (seed !== undefined) params.set("seed", String(seed));

  const res = await fetch(`${API_BASE_URL}/api/v1/feed?${params}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to fetch feed");
  return res.json();
}
