export type MovieDetail = {
  id: string;
  title: string;
  slug: string;
  description: string;
  thumbnail_url: string;
  sample_embed_url: string;
  actresses: string[];
  genres: string[];
  affiliate_url: string;
};

const API_BASE_URL = process.env.API_BASE_URL || "http://127.0.0.1:8000";

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