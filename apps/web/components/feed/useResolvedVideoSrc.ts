"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { resolveMp4Url } from "@/lib/api/resolve-mp4";
import { ensurePreconnect } from "@/lib/networkPrefs";
import { createVideoTimer } from "@/lib/videoTiming";

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
}

interface Result {
  videoSrc: string | null;
  exhausted: boolean;
  resolving: boolean;
  handleError: () => void;
}

const MAX_FORCE_RETRIES = 3;
const FORCE_RETRY_BACKOFF_MS = [500, 1000, 2000];

function pickPlaybackUrl(res: {
  mp4_url: string;
  high_mp4_url?: string | null;
}): string {
  // 単一 <video> 戦略では常に最高画質候補を採用する。
  return res.high_mp4_url || res.mp4_url;
}

export function useResolvedVideoSrc({ slug, enabled }: Args): Result {
  const [state, setState] = useState<State>({ phase: "resolving", url: null });

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
  }, [slug, clearBackoff]);

  useEffect(() => {
    if (!enabled) return;
    if (state.phase !== "resolving") return;
    if (inFlightRef.current) return;

    const controller = new AbortController();
    inFlightRef.current = controller;
    const timer = createVideoTimer(slug);
    timer.mark("resolve:start");
    void resolveMp4Url(slug, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) {
          return;
        }
        if (res?.mp4_url) {
          timer.mark("resolve:ok");
          const url = pickPlaybackUrl(res);
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

    void resolveMp4Url(slug, { force: true, signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        if (res?.mp4_url) {
          const url = pickPlaybackUrl(res);
          ensurePreconnect(url);
          setState({ phase: "ready", url });
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
  };
}
