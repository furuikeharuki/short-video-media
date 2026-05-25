/**
 * GET /api/v1/movies/{slug}/resolve-mp4 を叩いて、再生可能な MP4 URL を取得する。
 *
 * API 側は DB キャッシュを廃止しており、毎回 in-process httpx で DMM の
 * html5_player ページから抽出する。連打抑制は API 側の in-flight デデュープ * + 5 分の短期成功キャッシュとクライアント側のメモリキャッシュで二重に行う。
 *
 * - force=false (デフォルト): クライアント側 / サーバ側両方のメモリキャッシュ優先。
 * - force=true: <video> が再生エラーになったときのリトライ用。サーバ側の
 *   短期キャッシュもバイパスして DMM へ再アクセスさせる。
 *
 * 失敗時は null を返してサムネにフォールバック (例外は投げない)。
 */

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000";

export type ResolveMp4Response = {
  content_id: string | null;
  mp4_url: string;
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

/**
 * resolver は uncached で ~8.6s かかるため、ブラウザから同時に多数のリクエストを
 * 投げると上流 (Cloudflare / API) で 504 が出やすい。並列度を上限 8 に絞ることで
 * バーストを抑制する (resolver / jobs-worker 側も実測で 8 が最適という前提)。
 *
 * 上限内: 即座に fetch を発火。
 * 上限超過: FIFO で待機し、空きが出たら起動。待機中に AbortController が
 *           abort された場合は fetch せずに諦める。
 *
 * デデュープキャッシュ (resolveCache) は同一 slug の同時要求を 1 本にまとめる
 * 役割で、別 slug 同士の同時実行はここで絞る。
 */
const MAX_CONCURRENT_FETCHES = 8;
let activeFetches = 0;
const waiters: Array<() => void> = [];

function acquireSlot(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (activeFetches < MAX_CONCURRENT_FETCHES) {
    activeFetches += 1;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const onWake = () => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        // 起こされたが既に abort 済み → 次の waiter に渡す
        releaseSlot();
        resolve(false);
        return;
      }
      resolve(true);
    };
    const onAbort = () => {
      const idx = waiters.indexOf(onWake);
      if (idx >= 0) waiters.splice(idx, 1);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    waiters.push(onWake);
  });
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    // activeFetches は据え置きで次のリクエストに引き継ぐ
    next();
  } else {
    activeFetches = Math.max(0, activeFetches - 1);
  }
}

/** 504 / ネットワークエラーに対するリトライ待ち時間 (1.5〜3.0s ジッタ)。 */
function pickRetryDelayMs(): number {
  return 1500 + Math.floor(Math.random() * 1500);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

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
    // 1 度だけリトライ可能。504 / ネットワーク (タイムアウト含む) のときに発火。
    let attempt = 0;
    while (true) {
      const acquired = await acquireSlot(controller.signal);
      if (!acquired) return null; // 全 consumer abort
      let shouldRetry = false;
      let result: ResolveMp4Response | null = null;
      try {
        const res = await fetch(url, {
          method: "GET",
          // クライアントから直接叩くため Next.js のキャッシュは無効。
          // 連打抑制はクライアント・サーバ両方の in-flight デデュープに任せる。
          cache: "no-store",
          // 全 consumer が abort されたら fetch も中断する。
          signal: controller.signal,
        });
        if (res.ok) {
          const data = (await res.json()) as ResolveMp4Response;
          if (data && typeof data.mp4_url === "string" && data.mp4_url) {
            result = data;
          }
        } else if (
          // 504 (Gateway Timeout) / 502 (Bad Gateway) はバースト由来の可能性が高い
          // ので 1 度だけリトライ。それ以外 (404 など) は即サムネ。
          (res.status === 504 || res.status === 502) &&
          attempt === 0
        ) {
          shouldRetry = true;
        }
      } catch {
        // ネットワークエラー / タイムアウト / abort
        if (!controller.signal.aborted && attempt === 0) {
          shouldRetry = true;
        }
      } finally {
        // sleep に入る前に必ずスロットを返し、他の slug がそのスロットを使えるようにする。
        releaseSlot();
      }

      if (!shouldRetry) return result;
      attempt += 1;
      await sleep(pickRetryDelayMs(), controller.signal);
      if (controller.signal.aborted) return null;
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

