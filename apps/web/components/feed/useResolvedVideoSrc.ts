"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { resolveMp4Url } from "@/lib/api/resolve-mp4";

/**
 * フィード上の 1 作品について「実際に再生可能な MP4 URL」を解決して保持する hook。
 *
 * 流れ:
 *   1. 初期表示時、DB の sample_movie_url があればそれを optimistic に使う。
 *      (ユーザーは即時に動画を試せる)
 *   2. なければ resolve-mp4 を呼んで取得する。
 *   3. <video> が onError を発火したら force=true で resolve-mp4 を呼び直す。
 *      DMM のトークンが期限切れになった場合のリトライ。
 *      1 回失敗したら諦めてサムネに落とす (videoSrc=null)。
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
  | { phase: "retrying"; src: null }
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
  handleError: () => void;
}

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

  // 1 つのカードにつき force リトライは 1 回まで。
  const forceRetriedRef = useRef(false);
  // 同じカードに対して同時に API を叩かない。
  const inFlightRef = useRef<AbortController | null>(null);

  // isActive=true になった or cachedSrc が空のときに resolve を起動する。
  // cachedSrc が変わったら状態をリセット (slug 変化時もここで拾える)。
  useEffect(() => {
    // slug / cachedSrc が変わったので試行回数をリセット
    forceRetriedRef.current = false;
    if (inFlightRef.current) {
      inFlightRef.current.abort();
      inFlightRef.current = null;
    }
    if (cachedSrc) {
      setState({ phase: "initial", src: cachedSrc });
    } else {
      setState({ phase: "resolving", src: null });
    }
  }, [slug, cachedSrc]);

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

  // <video> がエラーになったときのリトライ。
  // 1 回だけ force=true で resolve を呼び直し、それでもダメならサムネに落とす。
  const handleError = useCallback(() => {
    if (forceRetriedRef.current) {
      setState({ phase: "exhausted", src: null });
      return;
    }
    forceRetriedRef.current = true;

    if (inFlightRef.current) {
      inFlightRef.current.abort();
    }
    const controller = new AbortController();
    inFlightRef.current = controller;
    setState({ phase: "retrying", src: null });

    void resolveMp4Url(slug, { force: true, signal: controller.signal })
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
  }, [slug]);

  // アンマウント時に飛んでいるリクエストをキャンセル。
  useEffect(() => {
    return () => {
      if (inFlightRef.current) {
        inFlightRef.current.abort();
        inFlightRef.current = null;
      }
    };
  }, []);

  return {
    videoSrc: state.src,
    exhausted: state.phase === "exhausted",
    handleError,
  };
}
