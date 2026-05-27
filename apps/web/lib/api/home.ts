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
