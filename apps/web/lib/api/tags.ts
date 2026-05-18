/**
 * 登録件数の多いジャンルを limit 件返す。
 * ヘッダーの人気ジャンルタグ表示に使う。
 */
export async function fetchPopularTags(limit = 10): Promise<string[]> {
  // ブラウザに初期表示されるヘッダーから呼ぶので、認証クッキー付きの
  // プロキシ (/api/proxy) は不要。クライアントから直接 NEXT_PUBLIC_API_BASE_URL を叩く。
  const base =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";
  const res = await fetch(
    `${base}/api/v1/tags/popular?limit=${encodeURIComponent(String(limit))}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error("fetchPopularTags failed");
  const data: unknown = await res.json();
  return Array.isArray(data) ? (data as string[]) : [];
}
