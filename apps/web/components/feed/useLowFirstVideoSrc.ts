"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ensurePreconnect } from "@/lib/networkPrefs";
import { createVideoTimer, isVideoTimingEnabled } from "@/lib/videoTiming";

/**
 * 低画質ファースト戦略の hook。
 *
 * 動作:
 *   1. `lowSrc` を `<video>` に渡してすぐ再生開始させる (= ファーストペイント最優先)。
 *   2. `lowSrc` と `highSrc` が異なるときに限り、裏で `highSrc` の `<video>` を
 *      プリロードする。`canplay` (= 現在位置のフレームを再生し続けられる) に
 *      到達したタイミングでメイン `<video>` の src を `highSrc` に差し替える。
 *   3. スワップ時は `currentTime` / `muted` / `volume` / `playbackRate` / `paused`
 *      状態を保持し、ユーザーから見ると「画質が良くなる以外、何も変わらない」よう振る舞う。
 *
 * 安全策:
 *   - スワップは 1 つの slug あたり 1 度だけ。
 *   - low/high が同一 URL のとき (single-bitrate / 旧 API) はスワップを発火しない。
 *   - 高画質側がエラー / 長時間 canplay に到達しなかったケースでは、現在の low 再生を
 *     そのまま続ける (= ユーザーから見ると低画質のまま、再生は止まらない)。
 *   - 高速スワイプ中はスワップを抑制し、隣接スライドの帯域を中央に集中させる。
 *   - 隣接スライド (isActive=false) ではプリロード自体を開始しない。Safari の
 *     同時接続上限 (~4) を超えるのを避ける。
 *
 * 戻り値:
 *   - `currentSrc`: メイン `<video>` の src に渡す URL (low から high へ自動遷移)。
 *   - `isHigh`: 現在 high にスワップ済みか (デバッグ / UI 用)。
 *   - `prepareHighProbe`: 高画質プローブ `<video>` を制御する props
 *      (FeedItem 側で hidden video としてマウントする)。
 */

interface Args {
  /** 低画質候補 (resolver が返した low_mp4_url)。null のときは hook はスワップを行わない。 */
  lowSrc: string | null;
  /** 高画質候補 (resolver が返した high_mp4_url)。lowSrc と同一 / null のときはスワップ不要。 */
  highSrc: string | null;
  /** 再生対象の <video> 要素。スワップ時に src を直接書き換え currentTime を引き継ぐ。 */
  videoRef: React.RefObject<HTMLVideoElement>;
  /** 中央スライドのみスワップを発火する。隣接や Save-Data 等では false。 */
  enabled: boolean;
  /** 高速スワイプ中は false にしてプリロードを抑制する。 */
  allowPrepare: boolean;
  /**
   * slug が変わったら hook の内部状態 (スワップ済みフラグ / プローブ src) を
   * 全リセットする。同じ <video> 要素が再利用されるケースに備える。
   */
  slug: string;
  /**
   * 再生開始の最小許容秒数 (= プロ女優作品の先頭スキップ 5 秒など)。
   * src 差し替え時に `<video>` の `currentTime` がブラウザの `emptied` で 0 に
   * 戻されるが、ここで指定した値より小さい位置に復帰させないようクランプする。
   * 0 / undefined のときは従来通り直前位置 (prevTime) をそのまま使う。
   */
  minStartTime?: number;
}

interface HighProbeProps {
  src: string | null;
  onCanPlay: () => void;
  onError: () => void;
}

interface Result {
  currentSrc: string | null;
  isHigh: boolean;
  highProbe: HighProbeProps;
}

export function useLowFirstVideoSrc({
  lowSrc,
  highSrc,
  videoRef,
  enabled,
  allowPrepare,
  slug,
  minStartTime = 0,
}: Args): Result {
  // 現在のメイン <video> の src 表示状態。React の <video src={currentSrc}> として描画される。
  const [currentSrc, setCurrentSrc] = useState<string | null>(lowSrc ?? null);
  // 同じ slug について既にスワップ済みかどうか。1 度しか発火させない。
  const swappedRef = useRef(false);
  // プローブ <video> がプリロード中かどうか (allowPrepare=false で取り下げる用)。
  const [probeSrc, setProbeSrc] = useState<string | null>(null);
  const lastSlugRef = useRef(slug);

  // slug が変わったら全リセット。
  useEffect(() => {
    if (lastSlugRef.current !== slug) {
      lastSlugRef.current = slug;
      swappedRef.current = false;
      setProbeSrc(null);
      setCurrentSrc(lowSrc ?? null);
    }
  }, [slug, lowSrc]);

  // lowSrc が新たに resolve されたタイミングで currentSrc に反映。
  // (slug は同じだが initial resolve 完了後など)
  useEffect(() => {
    if (swappedRef.current) return; // 既に high にスワップ済み → 上書きしない
    if (lowSrc && currentSrc !== lowSrc && currentSrc !== highSrc) {
      setCurrentSrc(lowSrc);
    }
  }, [lowSrc, highSrc, currentSrc]);

  // プローブの起動条件:
  //   - 中央スライド (enabled) で、
  //   - 高速スワイプ中ではなく (allowPrepare)、
  //   - low と high が両方そろっていて URL が異なり、
  //   - まだスワップ済みでない。
  // 条件が崩れたらプローブ src を null にしてアンマウントし、帯域を解放する。
  useEffect(() => {
    if (!enabled || !allowPrepare) {
      if (probeSrc !== null) setProbeSrc(null);
      return;
    }
    if (swappedRef.current) {
      if (probeSrc !== null) setProbeSrc(null);
      return;
    }
    if (!lowSrc || !highSrc || lowSrc === highSrc) {
      if (probeSrc !== null) setProbeSrc(null);
      return;
    }
    if (probeSrc !== highSrc) {
      setProbeSrc(highSrc);
    }
  }, [enabled, allowPrepare, lowSrc, highSrc, probeSrc]);

  // プローブの canplay ハンドラ。条件が揃っていればここでスワップ発火。
  const handleProbeCanPlay = useCallback(() => {
    if (swappedRef.current) return;
    if (!highSrc || !lowSrc || lowSrc === highSrc) return;
    if (!enabled) return;

    const video = videoRef.current;
    if (!video) {
      // <video> がまだマウントされていない or アンマウント済み。今は何もしない;
      // <video> が再マウントされて低画質を再生してから、再度プローブ canplay を待つ。
      return;
    }

    // 現在の low 再生状態を保存。
    // 「プロ女優」(= minStartTime > 0) 作品では、probe canplay が低画質側の loadedmetadata
    // よりも先に発火するケースがあり、その時点では video.currentTime はまだブラウザ初期値
    // (0 付近) になっている。そのまま prevTime として保存して swap 後に書き戻すと、
    // 高画質側を 0 秒から再生してしまい、useFeedPlayback 側の 5 秒下限クランプより前に
    // 一瞬 5 秒スキップが効かなくなる。
    // そのため prevTime は最低でも minStartTime まで持ち上げる。
    const rawPrevTime = video.currentTime;
    const prevTime = Math.max(minStartTime, rawPrevTime);
    const wasPaused = video.paused;
    const prevRate = video.playbackRate;
    // muted / volume は React の <video muted /> 経由で常に反映されるが、
    // ブラウザによっては src 差し替え時に attribute から再構築されるので
    // 明示的にも保持しておく。
    const prevMuted = video.muted;
    const prevVolume = video.volume;

    // React の state を更新 → <video src> が差し替わる。
    // 再 canplay まで <video> のフレームは「最後にデコードされた低画質フレーム」が表示され続けるため、
    // 黒画面は走らない。
    swappedRef.current = true;
    setCurrentSrc(highSrc);
    // プローブはもう不要なのでアンマウント。
    setProbeSrc(null);

    if (isVideoTimingEnabled()) {
      const timer = createVideoTimer(slug);
      timer.mark("quality:high-swap");
    }

    // React の commit が完了して <video> の src 属性が更新された後で、
    // currentTime を復帰させたい。requestAnimationFrame で 1 フレーム後に実行する。
    // (loadedmetadata を待つ方が安全だが、その時点でのアタッチには別 effect が必要になるので
    //  最初の試行は rAF で、失敗 (まだ readyState が低い) なら loadedmetadata で再試行する。)
    requestAnimationFrame(() => {
      const v = videoRef.current;
      if (!v) return;
      v.muted = prevMuted;
      try {
        v.volume = prevVolume;
      } catch {
        /* ignore */
      }
      // メタデータがまだ無ければ currentTime をセットできない (DOMException)。
      // その場合は下の loadedmetadata ハンドラで再度復帰させる。
      if (Number.isFinite(v.duration) && v.duration > 0) {
        try {
          v.currentTime = Math.min(prevTime, Math.max(0, v.duration - 0.05));
        } catch {
          /* readyState が HAVE_METADATA 未到達 */
        }
      }
      v.playbackRate = prevRate;
      if (!wasPaused) {
        v.play().catch(() => {
          /* 高画質 play() reject 時は useFeedPlayback の autoplay observer 経由で復旧 */
        });
      }
    });

    // loadedmetadata まで currentTime を引き継げないケース用の再試行。
    const v = video;
    const onMeta = () => {
      v.removeEventListener("loadedmetadata", onMeta);
      try {
        if (Number.isFinite(v.duration) && v.duration > 0) {
          v.currentTime = Math.min(prevTime, Math.max(0, v.duration - 0.05));
        }
      } catch {
        /* ignore */
      }
      if (!wasPaused && v.paused) {
        v.play().catch(() => {});
      }
    };
    v.addEventListener("loadedmetadata", onMeta, { once: true });
  }, [highSrc, lowSrc, enabled, slug, videoRef, minStartTime]);

  // プローブが onError を出したら、スワップを諦めて low 再生を続ける。
  const handleProbeError = useCallback(() => {
    // 再試行はしない。ユーザーから見ると低画質のまま再生は続く。
    setProbeSrc(null);
    // swappedRef を立てて、以降このスライドではスワップしないようにする。
    swappedRef.current = true;
  }, []);

  // currentSrc に preconnect。useResolvedVideoSrc 側でも前倒し preconnect しているため通常重複する
  // が、SSR キャッシュやリトライ経路で抜けがあるケースに備える。
  useEffect(() => {
    if (currentSrc) ensurePreconnect(currentSrc);
  }, [currentSrc]);

  return {
    currentSrc,
    isHigh: swappedRef.current,
    highProbe: {
      src: probeSrc,
      onCanPlay: handleProbeCanPlay,
      onError: handleProbeError,
    },
  };
}

