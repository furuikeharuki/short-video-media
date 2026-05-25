/**
 * 動画の起動時刻を計測する開発用ユーティリティ。
 *
 * 設計:
 *   - デフォルトでは何もしない (本番でコンソールを汚さない)。
 *   - 以下のいずれかが true のときだけログを出す:
 *       1. process.env.NODE_ENV !== "production"
 *       2. ?vt=1 が URL に付いている (本番でもオプトイン計測できる)
 *       3. localStorage.video_timing === "1"
 *   - 1 つの <video> につき: resolve 開始 → resolve 完了 → loadedmetadata
 *     → canplay → playing → (途中の) waiting / stalled をマークして
 *     コンソールに送る。
 *
 * 形式:
 *   - グループ化はしない。ログ 1 行 = "vt {slug}: {event} +{ms}ms"。
 *   - 高速スワイプ中はログがバーストするが、開発用なので許容。
 */

let cachedEnabled: boolean | null = null;

export function isVideoTimingEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  if (typeof window === "undefined") {
    cachedEnabled = false;
    return false;
  }
  // 本番ビルドでも明示オプトインで計測できるよう、env だけでなく
  // クエリ / localStorage も見る。
  let enabled = process.env.NODE_ENV !== "production";
  try {
    if (window.location?.search?.includes("vt=1")) enabled = true;
  } catch { /* ignore */ }
  try {
    if (window.localStorage?.getItem("video_timing") === "1") enabled = true;
  } catch { /* ignore */ }
  cachedEnabled = enabled;
  return enabled;
}

/**
 * 1 つの <video> 用のタイマー。start() を呼ぶと開始時刻 (performance.now()) を
 * 記録し、以降の mark(event) で経過 ms を出力する。
 */
export interface VideoTimer {
  mark(event: string): void;
  reset(): void;
}

export function createVideoTimer(label: string): VideoTimer {
  if (!isVideoTimingEnabled()) {
    return { mark: () => {}, reset: () => {} };
  }
  let t0 = 0;
  const tag = `vt ${label}`;
  return {
    mark(event: string) {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (t0 === 0 || event === "start") {
        t0 = now;
        // 開始ログだけは "+0ms" 固定
        // eslint-disable-next-line no-console
        console.debug(`${tag}: ${event} +0ms`);
        return;
      }
      const elapsed = Math.round(now - t0);
      // eslint-disable-next-line no-console
      console.debug(`${tag}: ${event} +${elapsed}ms`);
    },
    reset() {
      t0 = 0;
    },
  };
}
