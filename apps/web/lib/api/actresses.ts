import { cache } from "react";

import type { MovieCard } from "./feed";

export type ActressProfile = {
  id: number;
  name: string;
  slug: string | null;
  ruby: string | null;
  thumbnail_url: string | null;
  image_url_small: string | null;
  image_url_large: string | null;
  bust: number | null;
  cup: string | null;
  waist: number | null;
  hip: number | null;
  height: number | null;
  birthday: string | null;
  blood_type: string | null;
  hobby: string | null;
  prefectures: string | null;
  dmm_list_url: string | null;
};

export type ActressStats = {
  movie_count: number;
  total_review_count: number;
  average_review: number | null;
  top_genres: string[];
  top_makers: string[];
};

export type ActressDetail = {
  profile: ActressProfile;
  stats: ActressStats;
  movies: MovieCard[];
};

const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000";

// React.cache: 同一リクエスト内で generateMetadata と page が両方呼んでも fetch は 1 回のみ
export const getActressByName = cache(
  async (name: string): Promise<ActressDetail> => {
    const res = await fetch(
      `${API_BASE_URL}/api/v1/actresses/${encodeURIComponent(name)}`,
      { next: { revalidate: 3600 } }, // プロフィールは頻繁に変わらないので 1 時間
    );

    if (res.status === 404) {
      throw new Error("NOT_FOUND");
    }
    if (!res.ok) {
      throw new Error("Failed to fetch actress detail");
    }
    return res.json();
  },
);
