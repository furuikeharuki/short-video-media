/**
 * GET /api/v1/movies/{slug}/resolve-mp4 を叩いて、再生可能な MP4 URL を取得する。
 *
 * - force=false (デフォルト): API 側で DB キャッシュ優先。
 * - force=true: <video> が再生エラーになったときのリトライ用。
 *   API 側で DB キャッシュを無視して resolver を呼び直す。
 *
 * 失敗時は null を返してサムネにフォールバック (例外は投げない)。
 */

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000";

export type ResolveMp4Response = {
  content_id: string | null;
  mp4_url: string;
  cached: boolean;
};

export async function resolveMp4Url(
  slug: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<ResolveMp4Response | null> {
  if (!slug) return null;
  const params = new URLSearchParams();
  if (options.force) params.set("force", "true");
  const query = params.toString();
  const url = `${API_BASE_URL}/api/v1/movies/${encodeURIComponent(slug)}/resolve-mp4${
    query ? `?${query}` : ""
  }`;

  try {
    const res = await fetch(url, {
      method: "GET",
      // クライアントから直接叩くため Next.js のキャッシュは無効。
      // API 側で DB キャッシュを持っているのでここでキャッシュする必要はない。
      cache: "no-store",
      signal: options.signal,
    });
    if (!res.ok) {
      // 404 / 502 / 504 はサムネフォールバック (UX 上は同じ扱い)
      return null;
    }
    const data = (await res.json()) as ResolveMp4Response;
    if (!data || typeof data.mp4_url !== "string" || !data.mp4_url) {
      return null;
    }
    return data;
  } catch {
    // ネットワークエラー / Abort
    return null;
  }
}
