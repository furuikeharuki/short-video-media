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
 *      DMM のトークンが期限切れになった場合のリトライ。
 *   3. force リトライは指数バックオフで最大 MAX_FORCE_RETRIES 回まで試す。
 *   4. それでも失敗したら exhausted (サムネ表示)。
 *   5. ただし、その後そのカードが再び可視になったとき (enabled=false→true) は
 *      リトライカウンタをリセットして再挑戦する。
 *
 * 状態:
 *   - videoSrc: <video src> に渡す URL (null ならサムネ表示)
 *   - exhausted: フォールバック試行を使い切った (true ならサムネ確定)
 *   - handleError: <video> の onError から呼ぶリトライハンドラ
 */

type ResolvedUrls = {
  /** 既存呼び出し元向けの「最良の URL」(後方互換)。 */
  src: string;
  /** 低画質ファースト戦略用の即時再生 URL。src と同一になることもある。 */
  lowSrc: string;
  /** 高画質スワップ先 URL。src / lowSrc と同一になることもある。 */
  highSrc: string;
};

type State =
  | { phase: "resolving"; urls: null }
  | { phase: "ready"; urls: ResolvedUrls }
  | { phase: "retrying"; urls: ResolvedUrls | null }
  | { phase: "exhausted"; urls: null };

interface Args {
  slug: string;
  /** isActive=true のスライドだけ解決を走らせるための制御。 */
  enabled: boolean;
}

interface Result {
  videoSrc: string | null;
  /**
   * 低画質ファースト用の URL (有れば)。サーバーが low_mp4_url を返さなかった
   * (= 旧 API / 抽出失敗) ケースでは null。null のとき web は videoSrc (高画質)
   * を直接使う。
   */
  lowSrc: string | null;
  /** 高画質候補。low と同一の場合はスワップ不要。 */
  highSrc: string | null;
  exhausted: boolean;
  /**
   * resolver への問い合わせ中 / force リトライ中で videoSrc がまだない状態。
   * この値が true の間はサムネの上にローディングを導出するために使う。
   */
  resolving: boolean;
  handleError: () => void;
}

// 1 カードあたり force リトライを何回まで試すか。
// exhausted 状態を極力減らすため、複数回試行する。
const MAX_FORCE_RETRIES = 3;
// force リトライ間の待ち時間 (指数バックオフ)。500ms → 1000ms → 2000ms。
const FORCE_RETRY_BACKOFF_MS = [500, 1000, 2000];

function toResolvedUrls(
  res: { mp4_url: string; low_mp4_url?: string | null; high_mp4_url?: string | null },
): ResolvedUrls {
  // 旧 API ビルドからのレスポンス互換: low/high が無ければ mp4_url で埋める。
  const low = res.low_mp4_url ?? res.mp4_url;
  const high = res.high_mp4_url ?? res.mp4_url;
  return { src: res.mp4_url, lowSrc: low, highSrc: high };
}

export function useResolvedVideoSrc({ slug, enabled }: Args): Result {
  const [state, setState] = useState<State>({ phase: "resolving", urls: null });

  // 1 つのカードにつき force リトライをこれまで何回試したか。
  // 上限 (MAX_FORCE_RETRIES) を超えたら exhausted に落とす。
  const forceRetryCountRef = useRef(0);
  // 同じカードに対して同時に API を叩かない。
  const inFlightRef = useRef<AbortController | null>(null);
  // バックオフのタイマー ID (中断用)。
  const backoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 直前の enabled 値 (false→true への遷移を検出するため)。
  const prevEnabledRef = useRef(enabled);

  const clearBackoff = useCallback(() => {
    if (backoffTimerRef.current != null) {
      clearTimeout(backoffTimerRef.current);
      backoffTimerRef.current = null;
    }
  }, []);

  // slug が変わったらリセット。
  useEffect(() => {
    forceRetryCountRef.current = 0;
    if (inFlightRef.current) {
      inFlightRef.current.abort();
      inFlightRef.current = null;
    }
    clearBackoff();
    setState({ phase: "resolving", urls: null });
  }, [slug, clearBackoff]);

  // enabled のときだけ初回 resolve を発火。
  // 表示中でない (enabled=false) スライドまで API を叩くと無駄なので避ける。
  //
  // resolveMp4Url の中身は signal を fetch に伝搬しないため、ここで cleanup に
  // abort しても fetch は走り続ける。ただし、abort されると返り値が null になるため、
  // null = abort ケースは exhausted に落とさず resolving のままにして effect の
  // 再起動でリトライさせる。
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
          const urls = toResolvedUrls(res);
          // 解決した CDN origin (cc3001 系) に dyn preconnect。TCP/TLS を前倒し。
          // 低画質→高画質スワップで CDN ホストが異なるケースもあるため両方 preconnect。
          ensurePreconnect(urls.lowSrc);
          if (urls.highSrc !== urls.lowSrc) ensurePreconnect(urls.highSrc);
          setState({ phase: "ready", urls });
        } else {
          timer.mark("resolve:exhausted");
          setState({ phase: "exhausted", urls: null });
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

  // 単発の force resolve を発火するヘルパー。
  // resolveMp4Url を呼び、成功なら ready / 失敗なら次のリトライ or exhausted。
  const runForceResolve = useCallback(() => {
    if (inFlightRef.current) {
      inFlightRef.current.abort();
    }
    const controller = new AbortController();
    inFlightRef.current = controller;
    // リトライ中も現在の src を保持したまま phase だけ retrying に遷移させる。
    // これにより FeedItem の showVideo 判定 (videoSrc !== null) が保たれ、<video> 要素が
    // アンマウントされず thumbnail-bg (サムネ) にスイッチされるのを防ぐ。
    setState((prev) => ({ phase: "retrying", urls: prev.urls }));

    void resolveMp4Url(slug, { force: true, signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        if (res?.mp4_url) {
          const urls = toResolvedUrls(res);
          ensurePreconnect(urls.lowSrc);
          if (urls.highSrc !== urls.lowSrc) ensurePreconnect(urls.highSrc);
          setState({ phase: "ready", urls });
          return;
        }
        // null 応答だった: 次のリトライを試すかどうか
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
          setState({ phase: "exhausted", urls: null });
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // ネットワークエラー等も同様にリトライ扱い
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
          setState({ phase: "exhausted", urls: null });
        }
      })
      .finally(() => {
        if (inFlightRef.current === controller) {
          inFlightRef.current = null;
        }
      });
  }, [slug, clearBackoff]);

  // <video> がエラーになったときのリトライ。
  // force リトライを最大 MAX_FORCE_RETRIES 回まで指数バックオフで試す。
  // それでもダメならサムネに落とす。
  const handleError = useCallback(() => {
    if (forceRetryCountRef.current >= MAX_FORCE_RETRIES) {
      setState({ phase: "exhausted", urls: null });
      return;
    }
    forceRetryCountRef.current += 1;
    runForceResolve();
  }, [runForceResolve]);

  // enabled が false → true に切り替わったときの自動再試行。
  // スワイプで一度離れたカードに戻ってきたケースで、exhausted 状態のままなら
  // もう一度だけ force を試して復帰を狙う (トークン期限切れなどがタイミング依存のため)。
  useEffect(() => {
    const becameEnabled = !prevEnabledRef.current && enabled;
    prevEnabledRef.current = enabled;
    if (!becameEnabled) return;
    if (state.phase !== "exhausted") return;

    forceRetryCountRef.current = 1;
    runForceResolve();
  }, [enabled, state.phase, runForceResolve]);

  // アンマウント時に飛んでいるリクエスト / バックオフタイマーをキャンセル。
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

  const urls = state.urls;
  return {
    videoSrc: urls?.src ?? null,
    lowSrc: urls?.lowSrc ?? null,
    highSrc: urls?.highSrc ?? null,
    exhausted: state.phase === "exhausted",
    resolving: state.phase === "resolving" || state.phase === "retrying",
    handleError,
  };
}
