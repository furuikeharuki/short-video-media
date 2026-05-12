export type MovieCard = {
  id: string;
  title: string;
  slug: string;
  thumbnail_url: string;
  sample_embed_url: string;
  actresses: string[];
  genres: string[];
};

export type FeedResponse = {
  items: MovieCard[];
  next_cursor: string | null;
};

const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000";

export async function getFeed(): Promise<FeedResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/feed`, {
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error("Failed to fetch feed");
  }

  return res.json();
}