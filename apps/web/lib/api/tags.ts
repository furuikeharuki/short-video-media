/**
 * DBにデータがない間や fetch 失敗時に表示するフォールバックタグ。
 * FANZA APIからデータが入り始めれば自動的に上書きされる。
 */
const FALLBACK_TAGS = [
  "素人", "美少女", "OL", "巨乳", "ハード系",
  "中出し", "プロ作品", "VR", "独占配信", "ランキング上位",
];

/**
 * layout.tsx (Server Component) から呼ぶ。
 * INTERNAL_API_URL はサーバー間通信用（Docker内のサービス名など）。
 * 未設定なら localhost:8000 にフォールバック。
 */
const API_BASE =
  process.env.INTERNAL_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:8000";

export async function getPopularTags(limit = 20): Promise<string[]> {
  try {
    const res = await fetch(
      `${API_BASE}/api/v1/tags/popular?limit=${limit}`,
      {
        next: { revalidate: 3600 },
        // タイムアウト: 2秒以内に返らなければ諦めてフォールバックへ
        signal: AbortSignal.timeout(2000),
      }
    );
    if (!res.ok) return FALLBACK_TAGS;
    const tags: string[] = await res.json();
    // DBが空（0件）のときもフォールバックを返す
    return tags.length > 0 ? tags : FALLBACK_TAGS;
  } catch {
    return FALLBACK_TAGS;
  }
}
