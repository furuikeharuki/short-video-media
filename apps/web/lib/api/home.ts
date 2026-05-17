import type { MovieCard } from "./feed";

export type HomeSection = {
  key: string;
  title: string;
  subtitle: string | null;
  genre: string | null;
  items: MovieCard[];
};

export type HomeResponse = {
  sections: HomeSection[];
};

const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000";

export async function getHome(sectionLimit = 12): Promise<HomeResponse> {
  const params = new URLSearchParams({ section_limit: String(sectionLimit) });
  const res = await fetch(`${API_BASE_URL}/api/v1/home?${params}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to fetch home");
  return res.json();
}
