"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  extractHost,
  inferQualityTier,
  pickPlaybackUrl,
  resolveMp4Url,
} from "@/lib/api/resolve-mp4";
import { ensurePreconnect } from "@/lib/networkPrefs";
import { createVideoTimer, isVideoTimingEnabled } from "@/lib/videoTiming";

/**
 * フィード上の 1 作品について「実際に再生可能な MP4 URL」を解決して保持する hook。
 *
 * MP4 URL は DB に保存されておらず、apps/api 側の resolve-mp4 endpoint が
 * 再生時に in-process httpx で都度抽出する設計のため、本 hook も毎回
 * resolve-mp4 を叩いて URL を取得する。
 *
 * 流れ:
 *   1. enabled=true になったら resolve-mp4 を呼んで取得する。
 *   2. <video> が onError を発火したら force=true で resolve-mp4 を呼び直す。
 *   3. force リトライは指数バックオフで最大 MAX_FORCE_RETRIES 回まで試す。
 *   4. それでも失敗したら exhausted (サムネ表示)。
 *   5. ただし、その後そのカードが再び可視になったとき (enabled=false→true) は
 *      リトライカウンタをリセットして再挑戦する。
 *
 * 単一 <video> 戦略: 表示用 URL は `high_mp4_url || mp4_url` を採用する。
 * API が low_mp4_url を返してきても web では使用しない (低画質ファースト戦略は
 * 撤去済み)。
 */

type State =
  | { phase: "resolving"; url: null }
  | { phase: "ready"; url: string }
  | { phase: "retrying"; url: string | null }
  | { phase: "exhausted"; url: null };

interface Args {
  slug: string;
  /** isActive=true のスライドだけ解決を走らせるための制御。 */
  enabled: boolean;
  /**
   * このスライドが現在「画面中央 (active)」なのか「隣接 (adjacent) preload」
   * なのかを vt ログに残すためのフラグ。実行ロジックには影響しない。
   * 観測専用 (`source=active scope=adjacent` のように出る)。
   */
  isActive?: boolean;
}

interface Result {
  videoSrc: string | null;
  exhausted: boolean;
  resolving: boolean;
  handleError: () => void;
  /**
   * force-resolve (handleError) が ready に到達するたびに増えるカウンタ。
   *
   * 通常の resolve 完了 (= 初回 / slug 変更後) では 0 のまま。force-retry の結果
   * `phase: "ready"` に遷移したときだけ +1 する。これにより:
   *   - 上位 (FeedItem / useFeedPlayback) は「URL 文字列が変わったか」ではなく
   *     「force-resolve が新しい結果を返したか」を観測できる。
   *   - 同一 URL を再取得したケース (CDN 接続恒久断などで API が同じ URL を返す)
   *     でも、上位が認識して active <video> の load()/play() を撃ち直せる。
   * active session 切り替え (= slug 変更) で 0 にリセット。
   */
  forceResolveEpoch: number;
}

const MAX_FORCE_RETRIES = 3;
const FORCE_RETRY_BACKOFF_MS = [500, 1000, 2000];

/**
 * 解決結果の URL シグネチャを vt ログに残す (active / force-retry 共通)。
 *
 * セキュリティ: 署名クエリは含めず、host と末尾の画質ティア (sm/dm/dmb/mhb) だけ
 * を出す。これにより「ユーザーが見えている動画が高画質扱いになっているか」を
 * 観測しつつ、トークン付き URL をログに残さない。
 *
 * drift: mp4_url (= API primary = args.src) と high_mp4_url が異なる場合は
 * `drift=primary->high` を付ける。これが頻発するときは prefetch (= mp4_url を
 * 使う旧実装) と active (= high_mp4_url) が別 URL になり handoff src-mismatch を
 * 起こしていた。現在の実装は両者で pickPlaybackUrl(res) を共有するためログは
 * 不要だが、移行期と再発検知のために残す。
 */
function logSelectedQuality(
  slug: string,
  res: { mp4_url: string; high_mp4_url?: string | null },
  picked: string,
  source: "active" | "force-retry",
  // 「この resolver は呼ばれた時点で active として実行されたのか、隣接 (adjacent)
  // として実行されたのか」を vt ログで明示する。これが無いと、非 current slug が
  // adjacent としてリゾルブしたログ (source=active) が「アクティブが切り替わった
  // のか?」という混乱を呼ぶ。`source=active` は「初回 resolve / enabled=true 経路」
  // を意味し、slug が実際に画面中央にあるかどうかとは独立。
  scope: "active" | "adjacent",
) {
  if (!isVideoTimingEnabled()) return;
  const tier = inferQualityTier(picked);
  const host = extractHost(picked);
  const drift = res.high_mp4_url && res.high_mp4_url !== res.mp4_url
    ? "primary->high"
    : "none";
  // eslint-disable-next-line no-console
  console.debug(
    `vt resolve quality slug=${slug} source=${source} scope=${scope} quality=${tier} host=${host} drift=${drift}`,
  );
}

export function useResolvedVideoSrc({ slug, enabled, isActive = false }: Args): Result {
  // 最新の isActive を ref で握る。logSelectedQuality の発火タイミング (resolve
  // 完了時) は props 更新と完全には同期しないため、effect 内で「いま中央か?」を
  // 観測するには ref が必要。観測ログのためだけに使う。
  const isActiveRef = useRef(isActive);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);
  const [state, setState] = useState<State>({ phase: "resolving", url: null });
  // force-resolve が ready を生成した回数。slug 変更 / 初回 resolve では増えない。
  const [forceResolveEpoch, setForceResolveEpoch] = useState(0);

  const forceRetryCountRef = useRef(0);
  const inFlightRef = useRef<AbortController | null>(null);
  const backoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevEnabledRef = useRef(enabled);

  const clearBackoff = useCallback(() => {
    if (backoffTimerRef.current != null) {
      clearTimeout(backoffTimerRef.current);
      backoffTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    forceRetryCountRef.current = 0;
    if (inFlightRef.current) {
      inFlightRef.current.abort();
      inFlightRef.current = null;
    }
    clearBackoff();
    setState({ phase: "resolving", url: null });
    setForceResolveEpoch(0);
  }, [slug, clearBackoff]);

  useEffect(() => {
    if (!enabled) return;
    if (state.phase !== "resolving") return;
    if (inFlightRef.current) return;

    const controller = new AbortController();
    inFlightRef.current = controller;
    const timer = createVideoTimer(slug);
    timer.mark("resolve:start");
    void resolveMp4Url(slug, {
      signal: controller.signal,
      priority: "high",
      onReuse: (kind) => {
        // 直前 prefetch/warm が走らせていた in-flight を共有 (in-flight) するか、
        // 1h 短期キャッシュにヒット (cached) した場合に発火。
        // vt ログ的には active が「待たずに済んだ」ことが見えるのが価値。
        timer.mark(`resolve:reuse-${kind}`);
      },
    })
      .then((res) => {
        if (controller.signal.aborted) {
          return;
        }
        if (res?.mp4_url) {
          timer.mark("resolve:ok");
          const url = pickPlaybackUrl(res);
          logSelectedQuality(
            slug,
            res,
            url,
            "active",
            isActiveRef.current ? "active" : "adjacent",
          );
          ensurePreconnect(url);
          setState({ phase: "ready", url });
        } else {
          timer.mark("resolve:exhausted");
          setState({ phase: "exhausted", url: null });
        }
      })
      .finally(() => {
        if (inFlightRef.current === controller) {
          inFlightRef.current = null;
        }
      });

    return () => {
      controller.abort();
      if (inFlightRef.current === controller) {
        inFlightRef.current = null;
      }
    };
  }, [enabled, slug, state.phase]);

  const runForceResolve = useCallback(() => {
    if (inFlightRef.current) {
      inFlightRef.current.abort();
    }
    const controller = new AbortController();
    inFlightRef.current = controller;
    setState((prev) => ({ phase: "retrying", url: prev.url }));

    void resolveMp4Url(slug, {
      force: true,
      signal: controller.signal,
      priority: "high",
    })
      .then((res) => {
        if (controller.signal.aborted) return;
        if (res?.mp4_url) {
          const url = pickPlaybackUrl(res);
          logSelectedQuality(
            slug,
            res,
            url,
            "force-retry",
            isActiveRef.current ? "active" : "adjacent",
          );
          ensurePreconnect(url);
          let sameUrl = false;
          setState((prev) => {
            sameUrl = prev.url === url;
            return { phase: "ready", url };
          });
          setForceResolveEpoch((n) => {
            const next = n + 1;
            if (isVideoTimingEnabled()) {
              // eslint-disable-next-line no-console
              console.debug(
                `vt ${slug}: force-resolve complete epoch=${next} sameUrl=${sameUrl}`,
              );
            }
            return next;
          });
          return;
        }
        if (forceRetryCountRef.current < MAX_FORCE_RETRIES) {
          const backoffIdx = Math.min(
            forceRetryCountRef.current - 1,
            FORCE_RETRY_BACKOFF_MS.length - 1,
          );
          const wait = FORCE_RETRY_BACKOFF_MS[Math.max(0, backoffIdx)];
          clearBackoff();
          backoffTimerRef.current = setTimeout(() => {
            backoffTimerRef.current = null;
            forceRetryCountRef.current += 1;
            runForceResolve();
          }, wait);
        } else {
          setState({ phase: "exhausted", url: null });
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        if (forceRetryCountRef.current < MAX_FORCE_RETRIES) {
          const backoffIdx = Math.min(
            forceRetryCountRef.current - 1,
            FORCE_RETRY_BACKOFF_MS.length - 1,
          );
          const wait = FORCE_RETRY_BACKOFF_MS[Math.max(0, backoffIdx)];
          clearBackoff();
          backoffTimerRef.current = setTimeout(() => {
            backoffTimerRef.current = null;
            forceRetryCountRef.current += 1;
            runForceResolve();
          }, wait);
        } else {
          setState({ phase: "exhausted", url: null });
        }
      })
      .finally(() => {
        if (inFlightRef.current === controller) {
          inFlightRef.current = null;
        }
      });
  }, [slug, clearBackoff]);

  const handleError = useCallback(() => {
    if (forceRetryCountRef.current >= MAX_FORCE_RETRIES) {
      setState({ phase: "exhausted", url: null });
      return;
    }
    forceRetryCountRef.current += 1;
    runForceResolve();
  }, [runForceResolve]);

  useEffect(() => {
    const becameEnabled = !prevEnabledRef.current && enabled;
    prevEnabledRef.current = enabled;
    if (!becameEnabled) return;
    if (state.phase !== "exhausted") return;

    forceRetryCountRef.current = 1;
    runForceResolve();
  }, [enabled, state.phase, runForceResolve]);

  useEffect(() => {
    return () => {
      if (inFlightRef.current) {
        inFlightRef.current.abort();
        inFlightRef.current = null;
      }
      if (backoffTimerRef.current != null) {
        clearTimeout(backoffTimerRef.current);
        backoffTimerRef.current = null;
      }
    };
  }, []);

  return {
    videoSrc: state.url,
    exhausted: state.phase === "exhausted",
    resolving: state.phase === "resolving" || state.phase === "retrying",
    handleError,
    forceResolveEpoch,
  };
}
