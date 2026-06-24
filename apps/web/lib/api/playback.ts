/**
 * ※ サーバー専用モジュール (Server Component / Route Handler からのみ import する)。
 *   INTERNAL_API_BASE_URL などサーバー専用の env を参照するため、クライアント
 *   コンポーネントから import しないこと。
 *
 * サーバー側 (SSR / ISR) で作品の再生可能な MP4 URL を事前解決するヘルパー。
 *
 * 目的:
 *   作品詳細ページ (/movies/[slug]) の <video> は従来 `/videos/[slug]/sample.mp4`
 *   への 302 リダイレクト route を src にしていた。これは
 *     ブラウザ → Next route → API /resolve-mp4 → 302 → DMM CDN (新規 TLS)
 *   と最低 3 ホップを踏むため、再生開始まで待たされる。
 *
 *   ここで SSR 中に解決済みの「実 CDN 直リンク」を取得して <source> に直接
 *   埋め込めば、再生時のホップを 1 本 (CDN への range request) に短縮できる。
 *   さらに CDN origin に preconnect しておけば TLS も前倒しできる。
 *
 * 注意:
 *   - resolve-mp4 は cold だと数秒かかるため、SSR をブロックしすぎないよう
 *     短いタイムアウト (既定 1.2s) を設ける。間に合わなければ null を返し、
 *     呼び出し側はリダイレクト route の src にフォールバックする。
 *   - 詳細ページは revalidate=3600 (ISR) で、resolve-mp4 のキャッシュ TTL も
 *     1 時間。DMM トークンはそれより十分長く有効なため、埋め込んだ URL が
 *     キャッシュ期間中に失効することはない。
 */

const API_BASE_URL = (
  process.env.INTERNAL_API_BASE_URL ||
  process.env.API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000"
).replace(/\/+$/, "");

const DEFAULT_TIMEOUT_MS = 1200;

export type PlaybackUrl = {
  /** 実際に <source> に入れる再生可能な MP4 URL (高画質優先)。 */
  url: string;
  /** preconnect 用に取り出した URL の origin。解析不能なら null。 */
  origin: string | null;
};

type ResolveMp4Response = {
  mp4_url?: string | null;
  high_mp4_url?: string | null;
  low_mp4_url?: string | null;
};

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * SSR 中に再生 URL を解決する。間に合わない / 失敗時は null。
 *
 * - revalidate=3600 で Next 側にもキャッシュさせ、ISR ページと寿命を揃える。
 * - timeoutMs を超えたら abort して null を返し、SSR を遅らせない。
 */
export async function resolvePlaybackUrlSSR(
  slug: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PlaybackUrl | null> {
  if (!slug) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${API_BASE_URL}/api/v1/movies/${encodeURIComponent(slug)}/resolve-mp4`,
      {
        signal: controller.signal,
        next: { revalidate: 3600 },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as ResolveMp4Response;
    const url = data.high_mp4_url || data.mp4_url || data.low_mp4_url;
    if (!url) return null;
    return { url, origin: originOf(url) };
  } catch {
    // タイムアウト / ネットワーク失敗時はフォールバックに任せる。
    return null;
  } finally {
    clearTimeout(timer);
  }
}
