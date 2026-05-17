/**
 * クライアント側で見つけた有効なサンプル動画 URL を API に報告して
 * DB にキャッシュさせる軽量クライアント。
 *
 * フォールバックで動いた URL を学習させることで、次回以降は
 * オリジナル URL ではなくキャッシュ済みの URL で配信できる。
 *
 * 失敗してもユーザー体験に影響を与えないため、エラーは握りつぶす。
 * sessionStorage で slug 単位の重複送信を防止する。
 */

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000";

const STORAGE_PREFIX = "reported_sample_";

export async function reportSampleUrl(
  slug: string,
  sampleMovieUrl: string,
): Promise<void> {
  if (!slug || !sampleMovieUrl) return;

  // sessionStorage で slug 単位 dedupe (同じセッション内で何度も送らない)
  try {
    const key = `${STORAGE_PREFIX}${slug}`;
    if (typeof sessionStorage !== "undefined") {
      if (sessionStorage.getItem(key) === sampleMovieUrl) return;
      sessionStorage.setItem(key, sampleMovieUrl);
    }
  } catch {
    /* sessionStorage が使えない環境では dedupe を諦めて続行 */
  }

  try {
    await fetch(`${API_BASE_URL}/api/v1/movies/${encodeURIComponent(slug)}/sample-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sample_movie_url: sampleMovieUrl }),
      keepalive: true,
    });
  } catch {
    /* ignore */
  }
}
