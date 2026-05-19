"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { invalidateSampleUrl, resolveMp4Url } from "@/lib/api/resolve-mp4";

/**
 * フィード上の 1 作品について「実際に再生可能な MP4 URL」を解決して保持する hook。
 *
 * 流れ:
 *   1. 初期表示時、DB の sample_movie_url があればそれを optimistic に使う。
 *      (ユーザーは即時に動画を試せる)
 *   2. なければ resolve-mp4 を呼んで取得する。
 *   3. <video> が onError を発火したら force=true で resolve-mp4 を呼び直す。
 *      DMM のトークンが期限切れになった場合のリトライ。
 *   4. force リトライは指数バックオフで最大 MAX_FORCE_RETRIES 回まで試す。
 *   5. それでも失敗したら exhausted (サムネ表示)。
 *   6. ただし、その後そのカードが再び可視になったとき (enabled=false→true) は
 *      リトライカウンタをリセットして再挑戦する。
 *
 * 状態:
 *   - videoSrc: <video src> に渡す URL (null ならサムネ表示)
 *   - exhausted: フォールバック試行を使い切った (true ならサムネ確定)
 *   - handleError: <video> の onError から呼ぶリトライハンドラ
 */

type State =
  | { phase: "initial"; src: string | null }
  | { phase: "resolving"; src: null }
  | { phase: "ready"; src: string }
  | { phase: "retrying"; src: string | null }
  | { phase: "exhausted"; src: null };

interface Args {
  slug: string;
  /** DB の movies.sample_movie_url。クライアントが即時に試す optimistic な値。 */
  cachedSrc: string | null;
  /** isActive=true のスライドだけ解決を走らせるための制御。 */
  enabled: boolean;
}

interface Result {
  videoSrc: string | null;
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

export function useResolvedVideoSrc({
  slug,
  cachedSrc,
  enabled,
}: Args): Result {
  // optimistic: DB に値があればそのまま src として使う。
  const [state, setState] = useState<State>(() =>
    cachedSrc
      ? { phase: "initial", src: cachedSrc }
      : { phase: "resolving", src: null },
  );

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

  // slug / cachedSrc が変わったらリセット。
  useEffect(() => {
    forceRetryCountRef.current = 0;
    if (inFlightRef.current) {
      inFlightRef.current.abort();
      inFlightRef.current = null;
    }
    clearBackoff();
    if (cachedSrc) {
      setState({ phase: "initial", src: cachedSrc });
    } else {
      setState({ phase: "resolving", src: null });
    }
  }, [slug, cachedSrc, clearBackoff]);

  // cachedSrc が無い & enabled のときだけ初回 resolve を発火。
  // 表示中でない (enabled=false) スライドまで API を叩くと無駄なので避ける。
  useEffect(() => {
    if (!enabled) return;
    if (cachedSrc) return; // optimistic ヒット中は何もしない
    if (state.phase !== "resolving") return;
    if (inFlightRef.current) return;

    const controller = new AbortController();
    inFlightRef.current = controller;
    void resolveMp4Url(slug, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        if (res?.mp4_url) {
          setState({ phase: "ready", src: res.mp4_url });
        } else {
          setState({ phase: "exhausted", src: null });
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
  }, [enabled, cachedSrc, slug, state.phase]);

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
    // 新しい src が来たら setState で src が差し替わり、ブラウザがそのタイミングで新ロードを開始する。
    setState((prev) => ({ phase: "retrying", src: prev.src }));

    void resolveMp4Url(slug, { force: true, signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        if (res?.mp4_url) {
          setState({ phase: "ready", src: res.mp4_url });
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
          setState({ phase: "exhausted", src: null });
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
          setState({ phase: "exhausted", src: null });
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
  //
  // 加えて、キャッシュされた sample_movie_url を DB から NULL に戻すよう API に
  // 依頼する (fire-and-forget)。古い _mhb_w.mp4 パターンの URL が DB に残っている
  // ために ORB / 404 で毎回 force resolve が走る状態を「自然治癒」させるため。
  const handleError = useCallback(() => {
    void invalidateSampleUrl(slug);

    if (forceRetryCountRef.current >= MAX_FORCE_RETRIES) {
      setState({ phase: "exhausted", src: null });
      return;
    }
    forceRetryCountRef.current += 1;
    runForceResolve();
  }, [slug, runForceResolve]);

  // enabled が false → true に切り替わったときの自動再試行。
  // スワイプで一度離れたカードに戻ってきたケースで、exhausted 状態のままなら
  // もう一度だけ force を試して復帰を狙う (トークン期限切れなどがタイミング依存のため)。
  useEffect(() => {
    const becameEnabled = !prevEnabledRef.current && enabled;
    prevEnabledRef.current = enabled;
    if (!becameEnabled) return;
    if (state.phase !== "exhausted") return;

    // カウンタをリセットして再挑戦
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

  return {
    videoSrc: state.src,
    exhausted: state.phase === "exhausted",
    resolving: state.phase === "resolving" || state.phase === "retrying",
    handleError,
  };
}
