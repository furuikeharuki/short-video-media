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

/**
 * クライアント側メモリ内 in-flight デデュープキャッシュ。
 * 同じ slug を複数のコンポーネント (usePrefetchResolveMp4 / usePrefetchVideoBytes /
 * useResolvedVideoSrc) が同時に要求しても、API リクエストは 1 本にまとめる。
 * 解決済みの Promise もキャッシュして、二重リクエストを避ける。
 * force=true のリトライはキャッシュをバイパスし、成功したらキャッシュを上書きする。
 *
 * 重要 (PR #95): 内部の fetch には signal を渡さない。呼び出し元の signal は
 * 「Promise を await するか即座に null を返すか」の判定にのみ使う。
 * そうしないと、先に fetch を発火したコンポーネントがスクロールで abort されたときに、
 * 同じ slug を必要とする他のコンポーネント (例: 中央に到達した useResolvedVideoSrc)
 * まで巻き込まれて null が返ってきてしまう。fetch 自体は常に完走させて、
 * クライアント側と API 側キャッシュを確実に温める。
 */
const resolveCache = new Map<string, Promise<ResolveMp4Response | null>>();

export async function resolveMp4Url(
  slug: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<ResolveMp4Response | null> {
  if (!slug) return null;

  // 呼び出し元の signal が既に abort されていれば即座に null。
  // (ただし fetch はそれとは独立に走り続ける)
  if (options.signal?.aborted) return null;

  // force=false のケース、既にキャッシュにあればそれを返す (新規 API を叩かない)。
  if (!options.force) {
    const cached = resolveCache.get(slug);
    if (cached) return waitWithSignal(cached, options.signal);
  }

  const params = new URLSearchParams();
  if (options.force) params.set("force", "true");
  const query = params.toString();
  const url = `${API_BASE_URL}/api/v1/movies/${encodeURIComponent(slug)}/resolve-mp4${
    query ? `?${query}` : ""
  }`;

  // 内部 fetch には signal を渡さない。呼び出し元の abort は waitWithSignal で処理する。
  const promise: Promise<ResolveMp4Response | null> = (async () => {
    try {
      const res = await fetch(url, {
        method: "GET",
        // クライアントから直接叩くため Next.js のキャッシュは無効。
        // API 側で DB キャッシュを持っているのでここでキャッシュする必要はない。
        cache: "no-store",
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
      // ネットワークエラー
      return null;
    }
  })();

  // キャッシュに登録 (force も同様に上書きして 新しい URL を以降の読み出しに中継)。
  // 但し null (失敗) ケースはキャッシュしない (一時的なネットワークエラーのリトライを可能にする)。
  resolveCache.set(slug, promise);
  void promise.then((res) => {
    if (res === null && resolveCache.get(slug) === promise) {
      resolveCache.delete(slug);
    }
  });

  return waitWithSignal(promise, options.signal);
}

/**
 * 共有した Promise を await しつつ、呼び出し元の signal が abort されたら
 * 即座に null を返す (Promise 自体は abort されず走り続ける)。
 */
function waitWithSignal<T>(
  promise: Promise<T | null>,
  signal: AbortSignal | undefined,
): Promise<T | null> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    });
  });
}

/**
 * キャッシュされた sample_movie_url をサーバー側で NULL に戻すよう依頼する。
 *
 * <video> が ORB / 404 / その他の理由で再生に失敗したときに叩く。
 * 成功・失敗ともにエラーを抔ぐさない fire-and-forget 専用ヘルパー。
 */
export async function invalidateSampleUrl(slug: string): Promise<void> {
  if (!slug) return;
  // クライアント側メモリキャッシュも同時に無効化 (次回 resolveMp4Url で 新規 URL を取りに行く)。
  resolveCache.delete(slug);
  const url = `${API_BASE_URL}/api/v1/movies/${encodeURIComponent(slug)}/sample-url`;
  try {
    await fetch(url, { method: "DELETE", cache: "no-store" });
  } catch {
    // ネットワークエラーは無視 (次回アクセスでもう一度哼ぁるチャンスがある)
  }
}
