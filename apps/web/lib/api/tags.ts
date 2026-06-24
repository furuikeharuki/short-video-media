/**
 * 登録件数の多いジャンルを limit 件返す。
 * ヘッダーの人気ジャンルタグ表示に使う。
 */
const POPULAR_TAGS_CACHE_TTL_MS = 60 * 60 * 1000;

function readPopularTagsCache(limit: number): string[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(`popular-tags:${limit}`);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { expiresAt?: number; items?: unknown };
    const items = cached.items;
    if (
      !Array.isArray(items) ||
      !items.every((item) => typeof item === "string") ||
      typeof cached.expiresAt !== "number" ||
      Date.now() >= cached.expiresAt
    ) {
      return null;
    }
    return items as string[];
  } catch {
    return null;
  }
}

function writePopularTagsCache(limit: number, items: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      `popular-tags:${limit}`,
      JSON.stringify({
        expiresAt: Date.now() + POPULAR_TAGS_CACHE_TTL_MS,
        items,
      }),
    );
  } catch {
    // sessionStorage が使えない環境では通常 fetch のみに倒す。
  }
}

export async function fetchPopularTags(limit = 10): Promise<string[]> {
  const cached = readPopularTagsCache(limit);
  if (cached) return cached;

  // ブラウザに初期表示されるヘッダーから呼ぶので、認証クッキー付きの
  // プロキシ (/api/proxy) は不要。クライアントから直接 NEXT_PUBLIC_API_BASE_URL を叩く。
  const base =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";
  const res = await fetch(
    `${base}/api/v1/tags/popular?limit=${encodeURIComponent(String(limit))}`,
    { cache: "force-cache" },
  );
  if (!res.ok) throw new Error("fetchPopularTags failed");
  const data: unknown = await res.json();
  const items = Array.isArray(data)
    ? data.filter((item): item is string => typeof item === "string")
    : [];
  writePopularTagsCache(limit, items);
  return items;
}
