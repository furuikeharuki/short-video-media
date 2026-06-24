"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  extractBasename,
  extractHost,
  inferQualityTier,
  pickFastStartUrl,
  pickHighQualityUrl,
  pickPlaybackUrl,
  primeResolveMp4Cache,
  type ResolveMp4Response,
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
 * フィードでは初速優先で `low_mp4_url || mp4_url` から再生を開始する。
 * 高画質候補 (`high_mp4_url || mp4_url`) が別 URL なら Result として保持し、
 * 呼び出し側が active 再生安定後に `upgradeToHighQuality()` で切り替える。
 */

type State =
  | { phase: "resolving"; url: null; highUrl: null }
  | {
      phase: "ready";
      url: string;
      /** 低画質スタート URL。upgrade 後も保持し、高画質が詰まったときの fallback 先にする。 */
      fastUrl: string;
      highUrl: string | null;
      quality: "fast" | "high";
    }
  | { phase: "retrying"; url: string | null; highUrl: string | null }
  | { phase: "exhausted"; url: null; highUrl: null };
type ReadyState = Extract<State, { phase: "ready" }>;

type InitialResolvedMp4 = {
  content_id?: string | null;
  mp4_url?: string | null;
  low_mp4_url?: string | null;
  high_mp4_url?: string | null;
};

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
  initialResolved?: InitialResolvedMp4 | null;
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
  /** 現在の URL が低画質スタートで、高画質候補が別にある場合だけ入る。 */
  highQualitySrc: string | null;
  /** 高画質候補へ切り替える。候補が無い/既に高画質なら no-op。 */
  upgradeToHighQuality: () => void;
  /**
   * 高画質再生が詰まったときに低画質スタート URL へ戻す。再生位置は呼び出し側
   * (useFeedPlayback の resume) が保持する。戻したあとは highUrl を落として
   * 自動再 upgrade を抑止する (低⇄高の往復ループ防止)。
   */
  downgradeToFastQuality: () => void;
  /** 現在再生している URL の画質。ready 以外では null。 */
  currentQuality: "fast" | "high" | null;
  /** いま高画質再生中で、戻せる別の低画質 URL がある (= 高画質 fallback 可能)。 */
  canDowngrade: boolean;
}

const MAX_FORCE_RETRIES = 3;
const FORCE_RETRY_BACKOFF_MS = [500, 1000, 2000];

function normalizeResolved(value: InitialResolvedMp4 | null | undefined): ResolveMp4Response | null {
  if (!value?.mp4_url) return null;
  return {
    content_id: value.content_id ?? null,
    mp4_url: value.mp4_url,
    low_mp4_url: value.low_mp4_url || value.mp4_url,
    high_mp4_url: value.high_mp4_url || value.mp4_url,
  };
}

function readyStateFromResolved(res: ResolveMp4Response): ReadyState {
  const url = pickFastStartUrl(res);
  const highUrl = pickHighQualityUrl(res);
  const upgradeUrl = highUrl !== url ? highUrl : null;
  return {
    phase: "ready",
    url,
    fastUrl: url,
    highUrl: upgradeUrl,
    quality: upgradeUrl ? "fast" : "high",
  };
}

/**
 * 解決結果の URL シグネチャを vt ログに残す (active / force-retry 共通)。
 *
 * セキュリティ: 署名クエリは含めず、host と末尾の画質ティア (sm/dm/dmb/mhb) だけ
 * を出す。これにより「ユーザーが見えている動画が高画質扱いになっているか」を
 * 観測しつつ、トークン付き URL をログに残さない。
 *
 * drift=low->high は、低画質で開始して高画質へ切り替える候補があるケース。
 * primary->high は single URL 運用時の互換的な高画質寄せを示す。
 */
function logSelectedQuality(
  slug: string,
  res: {
    mp4_url: string;
    low_mp4_url?: string | null;
    high_mp4_url?: string | null;
  },
  picked: string,
  source: "active" | "force-retry" | "quality-upgrade" | "quality-downgrade",
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
  const low = res.low_mp4_url || res.mp4_url;
  const high = res.high_mp4_url || res.mp4_url;
  const drift =
    low !== high
      ? "low->high"
      : res.high_mp4_url && res.high_mp4_url !== res.mp4_url
        ? "primary->high"
        : "none";
  // `other` は extractor が拾った URL が辞書 4 種 (sm/dm/dmb/mhb) に当てはまらない
  // ケース。DMM 側が新サフィックスを使っているのか、SD しか出していないのかを
  // 切り分けるため、basename だけ (= 署名クエリは含めない安全な短い識別子) を残す。
  const extra = tier === "other" ? ` basename=${extractBasename(picked)}` : "";
  // eslint-disable-next-line no-console
  console.debug(
    `vt resolve quality slug=${slug} source=${source} scope=${scope} quality=${tier} host=${host} drift=${drift}${extra}`,
  );
}

export function useResolvedVideoSrc({
  slug,
  enabled,
  isActive = false,
  initialResolved = null,
}: Args): Result {
  // 最新の isActive を ref で握る。logSelectedQuality の発火タイミング (resolve
  // 完了時) は props 更新と完全には同期しないため、effect 内で「いま中央か?」を
  // 観測するには ref が必要。観測ログのためだけに使う。
  const isActiveRef = useRef(isActive);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);
  const [state, setState] = useState<State>(() => {
    const initial = normalizeResolved(initialResolved);
    return initial
      ? readyStateFromResolved(initial)
      : { phase: "resolving", url: null, highUrl: null };
  });
  // force-resolve が ready を生成した回数。slug 変更 / 初回 resolve では増えない。
  const [forceResolveEpoch, setForceResolveEpoch] = useState(0);

  const forceRetryCountRef = useRef(0);
  // 高画質 rebuffer で一度低画質へ落とした slug session では、force-resolve でも
  // 高画質を再選択しない。低⇄高の往復で何度も止まるのを防ぐためのラッチ。
  const forceResolvePrefersFastRef = useRef(false);
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
    forceResolvePrefersFastRef.current = false;
    if (inFlightRef.current) {
      inFlightRef.current.abort();
      inFlightRef.current = null;
    }
    clearBackoff();
    const initial = normalizeResolved(initialResolved);
    if (initial) {
      primeResolveMp4Cache(slug, initial);
      const nextState = readyStateFromResolved(initial);
      logSelectedQuality(
        slug,
        initial,
        nextState.url,
        "active",
        isActiveRef.current ? "active" : "adjacent",
      );
      setState(nextState);
    } else {
      setState({ phase: "resolving", url: null, highUrl: null });
    }
    setForceResolveEpoch(0);
  }, [
    slug,
    initialResolved?.content_id,
    initialResolved?.mp4_url,
    initialResolved?.low_mp4_url,
    initialResolved?.high_mp4_url,
    clearBackoff,
  ]);

  useEffect(() => {
    if (state.phase !== "ready") return;
    ensurePreconnect(state.url);
    if (state.highUrl) ensurePreconnect(state.highUrl);
  }, [state]);

  useEffect(() => {
    if (!enabled) return;
    if (initialResolved?.mp4_url) return;
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
          const url = pickFastStartUrl(res);
          const highUrl = pickHighQualityUrl(res);
          const upgradeUrl = highUrl !== url ? highUrl : null;
          logSelectedQuality(
            slug,
            res,
            url,
            "active",
            isActiveRef.current ? "active" : "adjacent",
          );
          ensurePreconnect(url);
          if (upgradeUrl) ensurePreconnect(upgradeUrl);
          setState({
            phase: "ready",
            url,
            fastUrl: url,
            highUrl: upgradeUrl,
            quality: upgradeUrl ? "fast" : "high",
          });
        } else {
          timer.mark("resolve:exhausted");
          setState({ phase: "exhausted", url: null, highUrl: null });
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
  }, [enabled, slug, state.phase, initialResolved?.mp4_url]);

  const runForceResolve = useCallback(() => {
    if (inFlightRef.current) {
      inFlightRef.current.abort();
    }
    const controller = new AbortController();
    inFlightRef.current = controller;
    setState((prev) => ({ phase: "retrying", url: prev.url, highUrl: prev.highUrl }));

    void resolveMp4Url(slug, {
      force: true,
      signal: controller.signal,
      priority: "high",
    })
      .then((res) => {
        if (controller.signal.aborted) return;
        if (res?.mp4_url) {
          const fastUrl = pickFastStartUrl(res);
          // 通常の force retry は現 URL が詰まった/壊れた後の救済なので高画質候補を
          // 優先する。ただし、高画質 rebuffer で一度低画質へ落とした session では
          // force retry でも低画質を維持し、低⇄高ループを起こさない。
          const preferFast = forceResolvePrefersFastRef.current;
          const url = preferFast ? fastUrl : pickPlaybackUrl(res);
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
            // force-retry は基本的に高画質を優先するが、低画質へ downgrade 済みの
            // session では fastUrl に固定する。高画質を選んだ場合だけ fastUrl を
            // fallback 先として保持し、再び詰まったら低画質へ落とせるようにする。
            return {
              phase: "ready",
              url,
              fastUrl,
              highUrl: null,
              quality: preferFast ? "fast" : "high",
            };
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
          setState({ phase: "exhausted", url: null, highUrl: null });
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
          setState({ phase: "exhausted", url: null, highUrl: null });
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
      setState({ phase: "exhausted", url: null, highUrl: null });
      return;
    }
    forceRetryCountRef.current += 1;
    runForceResolve();
  }, [runForceResolve]);

  const upgradeToHighQuality = useCallback(() => {
    setState((prev) => {
      if (prev.phase !== "ready") return prev;
      if (!prev.highUrl) return prev;
      if (prev.url === prev.highUrl) return { ...prev, highUrl: null, quality: "high" };
      if (isVideoTimingEnabled()) {
        logSelectedQuality(
          slug,
          {
            mp4_url: prev.url,
            low_mp4_url: prev.url,
            high_mp4_url: prev.highUrl,
          },
          prev.highUrl,
          "quality-upgrade",
          isActiveRef.current ? "active" : "adjacent",
        );
      }
      ensurePreconnect(prev.highUrl);
      return {
        phase: "ready",
        url: prev.highUrl,
        // 低画質スタート URL は upgrade 後も保持する。高画質が詰まったら
        // downgradeToFastQuality() でここへ戻して再生を止めない。
        fastUrl: prev.fastUrl,
        highUrl: null,
        quality: "high",
      };
    });
  }, [slug]);

  const downgradeToFastQuality = useCallback(() => {
    // この session では force-resolve も低画質優先にする。setState updater の実行を
    // 待たずに立てて、直後に rebuffer force retry が残っても高画質へ戻さない。
    forceResolvePrefersFastRef.current = true;
    setState((prev) => {
      if (prev.phase !== "ready") return prev;
      // 既に低画質、または戻せる別 URL が無いなら no-op。
      if (prev.quality !== "high") return prev;
      if (!prev.fastUrl || prev.fastUrl === prev.url) return prev;
      if (isVideoTimingEnabled()) {
        logSelectedQuality(
          slug,
          {
            mp4_url: prev.fastUrl,
            low_mp4_url: prev.fastUrl,
            high_mp4_url: prev.url,
          },
          prev.fastUrl,
          "quality-downgrade",
          isActiveRef.current ? "active" : "adjacent",
        );
      }
      ensurePreconnect(prev.fastUrl);
      // highUrl は null のままにして、この session での自動再 upgrade を止める
      // (低⇄高の往復で再生が何度も止まるのを防ぐ)。
      return {
        phase: "ready",
        url: prev.fastUrl,
        fastUrl: prev.fastUrl,
        highUrl: null,
        quality: "fast",
      };
    });
  }, [slug]);

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
    highQualitySrc: state.phase === "ready" ? state.highUrl : null,
    upgradeToHighQuality,
    downgradeToFastQuality,
    currentQuality: state.phase === "ready" ? state.quality : null,
    canDowngrade:
      state.phase === "ready" &&
      state.quality === "high" &&
      !!state.fastUrl &&
      state.fastUrl !== state.url,
  };
}
