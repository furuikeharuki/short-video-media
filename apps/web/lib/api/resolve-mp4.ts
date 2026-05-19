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
 *
 * 同じ slug を複数のコンポーネント (usePrefetchResolveMp4 / usePrefetchVideoBytes /
 * useResolvedVideoSrc) が同時に要求しても、API リクエストは 1 本にまとめる。
 *
 * AbortSignal の扱い (PR #95 → 改訂):
 *   - 内部 fetch には共用 AbortController を渡し、購読者 (consumer) を参照カウントで
 *     管理する。
 *   - 全ての consumer が abort された場合に限り、内部 fetch を実際に中断する。
 *   - これにより:
 *       * 高速スワイプで古い prefetch の signal が abort されても、まだ「中央に到達した
 *         useResolvedVideoSrc」など他の consumer が残っていれば fetch は止まらない。
 *       * 逆に、誰も必要としなくなった (全 consumer が abort) ケースでは
 *         無駄な resolver 呼び出しと帯域消費が実際に止まる。
 *   - force=true は常にキャッシュをバイパスして新規 fetch を立てる。
 */
type CacheEntry = {
  promise: Promise<ResolveMp4Response | null>;
  controller: AbortController;
  /** この in-flight に紐づく購読者数。0 になったら controller.abort()。 */
  refCount: number;
};

const resolveCache = new Map<string, CacheEntry>();

export async function resolveMp4Url(
  slug: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<ResolveMp4Response | null> {
  if (!slug) return null;

  // 呼び出し元の signal が既に abort されていれば即座に null。
  if (options.signal?.aborted) return null;

  // force=false のケース、既にキャッシュにあればそれを共有する。
  if (!options.force) {
    const cached = resolveCache.get(slug);
    if (cached) {
      return subscribe(slug, cached, options.signal);
    }
  }

  const params = new URLSearchParams();
  if (options.force) params.set("force", "true");
  const query = params.toString();
  const url = `${API_BASE_URL}/api/v1/movies/${encodeURIComponent(slug)}/resolve-mp4${
    query ? `?${query}` : ""
  }`;

  const controller = new AbortController();
  const promise: Promise<ResolveMp4Response | null> = (async () => {
    try {
      const res = await fetch(url, {
        method: "GET",
        // クライアントから直接叩くため Next.js のキャッシュは無効。
        // API 側で DB キャッシュを持っているのでここでキャッシュする必要はない。
        cache: "no-store",
        // 全 consumer が abort されたら fetch も中断する。
        signal: controller.signal,
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
      // ネットワークエラー / abort
      return null;
    }
  })();

  const entry: CacheEntry = { promise, controller, refCount: 0 };
  // force=true でも上書きしておく (これ以降の同一 slug 読み出しは新 URL を共有できる)。
  resolveCache.set(slug, entry);
  void promise.then((res) => {
    // 失敗 (null) ケースはキャッシュから外す = 次回再試行できる。
    if (res === null && resolveCache.get(slug) === entry) {
      resolveCache.delete(slug);
    }
  });

  return subscribe(slug, entry, options.signal);
}

/**
 * 共有 in-flight に consumer として subscribe する。
 *  - signal が abort されたら refCount を 1 減らし、0 になったら controller.abort()。
 *  - signal が無い consumer も 1 カウントされ、Promise 完了時に解放される。
 *  - signal が既に abort されていれば購読せず即 null。
 */
function subscribe(
  slug: string,
  entry: CacheEntry,
  signal: AbortSignal | undefined,
): Promise<ResolveMp4Response | null> {
  if (signal?.aborted) return Promise.resolve(null);

  entry.refCount += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      // 全 consumer が離脱 → 実 fetch を中断
      entry.controller.abort();
      if (resolveCache.get(slug) === entry) {
        resolveCache.delete(slug);
      }
    }
  };

  return new Promise<ResolveMp4Response | null>((resolve) => {
    const onAbort = () => {
      signal?.removeEventListener("abort", onAbort);
      release();
      resolve(null);
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    entry.promise.then((value) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      release();
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
