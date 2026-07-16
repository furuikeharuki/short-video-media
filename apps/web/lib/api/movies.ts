import { cache } from "react";

export type MovieDetail = {
  id: string;
  content_id: string | null;
  product_id: string | null;
  maker_product: string | null;
  title: string;
  slug: string;
  description: string;
  // DMM litevideo (__NEXT_DATA__) 由来の作品説明文。FANZA API の description とは別ソース。
  // 未取得の作品は null。詳細ページ / モーダルの「作品説明」セクションに表示する。
  dmm_description: string | null;
  // dmm_description から抽出した特徴語 (「この作品のキーワード」チップ用)。未抽出は空配列。
  dmm_keywords: string[];
  volume: number | null;
  image_url_list: string | null;
  image_url_large: string | null;
  sample_embed_url: string | null;
  affiliate_url: string;
  price_list: {
    list_price: number | null;
    sale_price: number | null;
    rental_price: number | null;
    delivery_price: number | null;
  } | null;
  price_min: number | null;
  release_date: string | null;
  delivery_date: string | null;
  rental_start_date: string | null;
  primary_date: string | null;
  review_count: number;
  review_average: number | null;
  director_name: string | null;
  label_name: string | null;
  maker_name: string | null;
  actresses: string[];
  genres: string[];
  series_name: string | null;
  // 10 秒以上再生に到達したユニーク feed_session 数。
  // interaction_events から都度集計 (canonical な watch_count 定義)。
  // 未集計 / 集計失敗時は null、まだ 1 watch も無いときは 0。
  watch_count: number | null;
};

const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000";

// React.cache: 同一リクエスト内でgenerateMetadataとpageが両方呼んでもfetchは1回のみ
export const getMovieBySlug = cache(async (slug: string): Promise<MovieDetail> => {
  const res = await fetch(`${API_BASE_URL}/api/v1/movies/${slug}`, {
    next: { revalidate: 3600 }, // 1時間キャッシュ。作品データは頻繁に変わらないため十分
  });

  if (res.status === 404) {
    throw new Error("NOT_FOUND");
  }

  if (!res.ok) {
    throw new Error("Failed to fetch movie detail");
  }

  return res.json();
});
