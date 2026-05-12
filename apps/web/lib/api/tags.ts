/**
 * DBにデータがない間や fetch 失敗時に表示するフォールバックタグ。
 */
export const FALLBACK_TAGS = [
  "素人", "美少女", "OL", "巨乳", "ハード系",
  "中出し", "プロ作品", "VR", "独占配信", "ランキング上位",
];

/**
 * ブラウザから直接叫び出すクライアント用関数。
 * NEXT_PUBLIC_API_URL を使用する。
 */
export async function fetchPopularTags(limit = 20): Promise<string[]> {
  const base =
    process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  try {
    const res = await fetch(
      `${base}/api/v1/tags/popular?limit=${limit}`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) return FALLBACK_TAGS;
    const tags: string[] = await res.json();
    return tags.length > 0 ? tags : FALLBACK_TAGS;
  } catch {
    return FALLBACK_TAGS;
  }
}
