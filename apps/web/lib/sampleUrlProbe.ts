/**
 * サンプル動画 URL の有効性をクライアント側で並列プローブする。
 *
 * 背景:
 *   - DMM CDN (cc3001.dmm.co.jp) は GeoIP で海外IP から 403 を返すため、
 *     サーバー側 (Railway) では URL の有効性を判定できない。
 *   - クライアント側で fetch HEAD/Range を投げる手もあるが、CORS で
 *     ステータスを読めない可能性がある。
 *   - 一方、<video preload="metadata"> はブラウザがネイティブに
 *     データを取りに行くため、CORS の制約を受けない。これを利用して
 *     "loadedmetadata" が発火した URL = 有効、と判定する。
 *
 * 並列数を制限することでモバイルの帯域・同時接続数を圧迫しない。
 */

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * 隠し <video> 要素を使って 1 つの URL が有効かどうかを判定する。
 * "loadedmetadata" が発火すれば有効、"error" / タイムアウトなら無効。
 */
function probeOne(url: string, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }

    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    // DOM には追加しない (オフスクリーンで読み込ませる)
    video.style.display = "none";

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      // 読み込みを止めて DOM から解放
      try {
        video.removeAttribute("src");
        video.load();
      } catch {
        /* ignore */
      }
    };

    const onMeta = () => {
      cleanup();
      resolve(true);
    };
    const onError = () => {
      cleanup();
      resolve(false);
    };
    const onAbort = () => {
      cleanup();
      resolve(false);
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    video.addEventListener("loadedmetadata", onMeta, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });

    video.src = url;
  });
}

/**
 * 候補 URL のリストに対して、並列で有効性を判定し、最初に有効と分かった URL を返す。
 * すべて無効なら null。
 */
export async function probeSampleUrls(
  candidates: readonly string[],
  options: { concurrency?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (candidates.length === 0) return null;
  if (typeof document === "undefined") return null;

  const controller = new AbortController();
  const queue = [...candidates];
  let found: string | null = null;

  // ワーカー関数: キューから URL を取り出して probe する。
  // 一つでも見つかったら controller.abort() で他のワーカーも止める。
  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const url = queue.shift();
      if (!url) return;
      const ok = await probeOne(url, controller.signal, timeoutMs);
      if (ok && !found) {
        found = url;
        controller.abort();
        return;
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker());
  await Promise.all(workers);
  return found;
}
