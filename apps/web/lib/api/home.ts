import type { MovieCard, PriceList } from "./feed";

export type HomeSection = {
  key: string;
  title: string;
  subtitle: string | null;
  genre: string | null;
  items: MovieCard[];
};

export type ActressCard = {
  id: number;
  name: string;
  slug: string | null;
  thumbnail_url: string | null;
  image_url_small: string | null;
  image_url_large: string | null;
};

export type HomeActressSection = {
  key: string;
  title: string;
  subtitle: string | null;
  items: ActressCard[];
};

export type GoodsCard = {
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
  maker_name: string | null;
};

export type HomeGoodsSection = {
  key: string;
  title: string;
  subtitle: string | null;
  items: GoodsCard[];
};

export type HomeResponse = {
  sections: HomeSection[];
  actress_sections?: HomeActressSection[];
  goods_sections?: HomeGoodsSection[];
};

const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000";

export async function getHome(sectionLimit = 20): Promise<HomeResponse> {
  const params = new URLSearchParams({ section_limit: String(sectionLimit) });
  // ホームの "人気 / 新着 / ランキング / ジャンル" は秒単位で変わるものではなく、
  // フィードからホームへ戻る導線が連発する局面 (BottomNav のタップ) で毎回 API を
  // 叩くと TTFB がそのまま体感の "遷移が重い" 感に直結する。
  // 短い ISR (30 秒) を入れて、連続アクセスではキャッシュ済み HTML を返せるようにする。
  // 厳密な最新性が必要なケース (例: page リロード直後に新規動画を即見せたい) には
  // 30 秒は十分短い。
  const res = await fetch(`${API_BASE_URL}/api/v1/home?${params}`, {
    next: { revalidate: 30 },
  });
  if (!res.ok) throw new Error("Failed to fetch home");
  return res.json();
}
