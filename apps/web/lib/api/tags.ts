const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/**
 * /api/v1/tags/popular から人気タグ名一覧を取得する。
 * 失敗時は空配列を返す（表示が壊れないように）。
 */
export async function getPopularTags(limit = 20): Promise<string[]> {
  try {
    const res = await fetch(
      `${API_BASE}/api/v1/tags/popular?limit=${limit}`,
      {
        next: { revalidate: 3600 }, // 1時間キャッシュ
      }
    );
    if (!res.ok) return [];
    return res.json() as Promise<string[]>;
  } catch {
    return [];
  }
}
