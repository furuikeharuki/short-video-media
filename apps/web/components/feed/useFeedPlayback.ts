"use client";

import { useEffect, useRef, useCallback, useState } from "react";

import { createVideoTimer, isVideoTimingEnabled, vtElementRole } from "@/lib/videoTiming";
import {
  PRO_ACTRESS_HEAD_SKIP_SEC,
  PRO_ACTRESS_MIN_DURATION_SEC,
} from "@/lib/proActress";

const SKIP_SEC = 5;
const DBL_TAP_MS = 300;
const LONG_PRESS_MS = 500;
const TAP_MOVE_THRESHOLD = 10;
const PLAY_THRESHOLD = 0.85;

let globalUserGestured = false;
let globalIsMuted = true;
let didCheckStartUnmutedFlag = false;

// ショートボタンを押して遷移してきたケース (sessionStorage.feed_start_unmuted=1) だけは
// そのクリックをユーザージェスチャーとみなして音声 ON で起動する。一回使ったらフラグは消す。
function consumeStartUnmutedFlag(): boolean {
  if (didCheckStartUnmutedFlag) return false;
  didCheckStartUnmutedFlag = true;
  if (typeof window === "undefined") return false;
  try {
    const flag = sessionStorage.getItem("feed_start_unmuted");
    if (flag === "1") {
      sessionStorage.removeItem("feed_start_unmuted");
      globalUserGestured = true;
      globalIsMuted = false;
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

// FeedViewer のスワイプ操作など、表示するスライドが変わったときに呼ばれ、
// 「この遷移はユーザー操作によるもの」と明示的にマークして unmuted 再生を許す。
export function markFeedGesture(): void {
  globalUserGestured = true;
}

interface UseFeedPlaybackOptions {
  slug: string;
  title: string;
  isActive: boolean;
  /**
   * 現在マウントされている <video> の src。
   * resolver で遅延取得されたケース、isActive=true になった時点では
   * まだ <video> がマウントされていないため、isActive だけを deps にしても
   * playVideo が呼ばれない。videoSrc を deps に含めることで
   * <video> マウント直後に一度 effect を再実行させ、自動再生を起動させる。
   * null の間 (resolver 待ちや exhausted) は <video> がそもそも存在しない。
   */
  videoSrc: string | null;
  onOpenModal: (slug: string) => void;
  /**
   * 「プロ女優」(= videoa フロア) ジャンルが付いた作品かどうか。
   * true のとき先頭 5 秒を完全に隠す:
   *   - 初回再生時に currentTime を 5 にセットして開始
   *   - -5s スキップで currentTime < 5 にならないようクランプ
   *   - video-seek (シークバー) も下限 5 秒でクランプ
   *   - timeupdate / seeking で currentTime < 5 を検知したら強制的に 5 に戻す
   *   - 再生終了 (ended) でループするときも 5 秒から再開
   * ただし duration が PRO_ACTRESS_MIN_DURATION_SEC 未満の場合は適用しない (動画が短すぎる)。
   */
  isProActress?: boolean;
}

export function useFeedPlayback({ slug, title, isActive, videoSrc, onOpenModal, isProActress = false }: UseFeedPlaybackOptions) {
  // 初回マウント時に一回だけショートボタンフラグを消費
  consumeStartUnmutedFlag();

  // dual-video 戦略 (useLowFirstVideoSrc) で、low → high の crossfade と同時に
  // 親の videoRef.current を high <video> 要素に付け替えるため、null 許容の
  // mutable ref として宣言する。`useRef<T>(null)` だと RefObject<T> (read-only `.current`)
  // になるが、`useRef<T | null>(null)` で MutableRefObject<T | null> になる。
  const videoRef     = useRef<HTMLVideoElement | null>(null);
  const sectionRef   = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shimmerRef   = useRef<HTMLDivElement>(null);
  const spinnerRef   = useRef<HTMLDivElement>(null);
  const fastBadgeRef = useRef<HTMLDivElement>(null);
  const overlayRef   = useRef<HTMLDivElement>(null);
  const rafRef       = useRef<number | null>(null);
  const isActiveRef  = useRef(false);

  const isPlayingRef             = useRef(false);
  // この <video> インスタンスで一度でも playing イベントが発火したかどうか。
  // 現在は主に「初回ロード完了後に shimmer タイマーをリセットしない」等の状態追跡用。
  // videoSrc が変わったとき (= 新しい作品に切り替わったとき) はリセット。
  const hasPlayedRef             = useRef(false);
  // スピナー表示を一定時間遅らせるためのタイマー ID。
  // waiting/stalled が短時間で解消する (= playing がすぐ来る) ようなケースで
  // スピナーがチラッと見えてしまうのを防ぐ。setSpinnerVisible(false) でクリアされる。
  const spinnerShowTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMutedRef               = useRef(globalIsMuted);
  const tapTimerRef              = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapCountRef              = useRef(0);
  const tapStartPosRef           = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const longPressTimerRef        = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLongPressRef           = useRef(false);
  const wasLongPressJustEndedRef = useRef(false);
  const isTouchDeviceRef         = useRef(false);
  const lastTouchEndRef          = useRef(0);
  const pcClickCountRef          = useRef(0);
  const pcClickTimerRef          = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isMuted,      setIsMuted]      = useState(globalIsMuted);
  // dual-video スワップで `videoRef.current` が low → high に付け替わったときに、
  // プロ女優スキップ用のイベントリスナを新しい要素に張り直すためのバージョン番号。
  // useLowFirstVideoSrc が `notifyVideoElementChange` を呼ぶたびにインクリメントされる。
  // この値を プロ女優スキップ effect の deps に含めることで、当該 effect が再実行されて
  // クリーンアップで旧要素から外し、再度新要素 (= videoRef.current) にリスナを張れる。
  const [videoElementVersion, setVideoElementVersion] = useState(0);
  const notifyVideoElementChange = useCallback(() => {
    setVideoElementVersion((v) => v + 1);
  }, []);

  // プロ女優スキップを適用すべきかどうかを ref に保持。<video> ごとの動的判定で、
  // メタデータロード後に duration を見て確定する (短すぎる動画は無効化)。
  const skipEffectiveRef = useRef(false);
  // プロ女優スキップ用の最小許容秒数。skipEffectiveRef が false なら 0。
  const skipLowerBoundRef = useRef(0);
  // プロ女優判定の最新値を ref に同期。playVideo は useCallback で deps を絞っていて
  // 再生成したくないので、ref 経由で最新の isProActress を読めるようにしておく。
  // (props の isProActress は useEffect で ref に書き写される)
  const isProActressRef = useRef(false);

  // 同 slug 作品で「直近の再生位置」を記憶しておく ref。
  // 再生中に <video> が onError → force リトライで src が差し替わったときに、
  // 新しい <video> の loadedmetadata タイミングで currentTime をこの位置に戻して
  // 「リトライしても最初から再生しない」を実現する。
  // slug が変わった (新しい作品にスワイプ) ときは time を 0 にリセット。
  const lastPlaybackRef = useRef<{ slug: string; time: number }>({ slug: "", time: 0 });

  // slug が変わったら lastPlaybackRef をリセット。同じ <video> 上で src が差し替わる force リトライのときだけ
  // 以前の位置を保持したいため、videoSrc 変化ではリセットしないことに注意。
  useEffect(() => {
    if (lastPlaybackRef.current.slug !== slug) {
      lastPlaybackRef.current = { slug: "", time: 0 };
    }
  }, [slug]);

  useEffect(() => {
    const sync = () => {
      if (isMutedRef.current !== globalIsMuted) {
        isMutedRef.current = globalIsMuted;
        setIsMuted(globalIsMuted);
        const video = videoRef.current;
        if (video) video.muted = globalIsMuted;
      }
    };
    window.addEventListener("global-mute-change", sync);
    return () => window.removeEventListener("global-mute-change", sync);
  }, []);

  // 初回ロード中のサムネイル背景 (.shimmer) と、一時停止アイコンと同じ
  // .overlay-wrap 内で中央に表示されるローディングスピナー (.loading-spinner) は
  // 独立して制御する。そうしないとキャッシュ切れで再バッファーしたときに
  // スピナーだけ表示したいケースをサポートできない。
  //
  // 注: この関数は <video> の opacity のみ制御する。shimmer の表示制御は
  // setShimmerVisible で独立に行う (プリフェッチ済スライドでサムネが
  // 一瞬見えるチラつきを避けるため、shimmer は loadstart/loadedmetadata ベースで
  // 動かす)。
  const setVideoReady = useCallback((ready: boolean) => {
    const video = videoRef.current;
    if (video) video.style.opacity = ready ? "1" : "0";
  }, []);

  // shimmer (サムネ画像背景) の表示制御。
  //
  // 現在の設計では shimmer は「動画取得・再生がどうしてもできない状況 (onError)」
  // のフォールバックサムネとしてのみ使用される。
  // 通常のロード中は <video> の最初の 1 フレームが表示されたままスピナーだけが出る設計。
  const setShimmerVisible = useCallback((visible: boolean) => {
    const shimmer = shimmerRef.current;
    if (shimmer) shimmer.style.display = visible ? "block" : "none";
  }, []);

  // ローディングスピナーの表示・非表示を切り替える。
  // - 初回ロード中: サムネイル + スピナーを重ねて表示
  // - 再生中のバッファ不足 (waiting/stalled): スピナーのみ表示
  //
  // visible=true のときは即座に表示せず、SPINNER_SHOW_DELAY_MS だけ遅延させる。
  // これにより「200ms 以内に解決する一瞬の waiting」ではスピナーが見えず、
  // 本当に長引いたときだけスピナーが出る。
  // visible=false のときはタイマーをキャンセルし、即座に非表示。
  const SPINNER_SHOW_DELAY_MS = 250;
  const setSpinnerVisible = useCallback((visible: boolean) => {
    const el = spinnerRef.current;
    if (!el) return;
    if (visible) {
      // すでに表示要求が走っている / すでに表示済みなら何もしない
      if (spinnerShowTimerRef.current != null) return;
      if (el.style.display === "flex") return;
      spinnerShowTimerRef.current = setTimeout(() => {
        spinnerShowTimerRef.current = null;
        const cur = spinnerRef.current;
        if (cur) cur.style.display = "flex";
      }, SPINNER_SHOW_DELAY_MS);
    } else {
      if (spinnerShowTimerRef.current != null) {
        clearTimeout(spinnerShowTimerRef.current);
        spinnerShowTimerRef.current = null;
      }
      el.style.display = "none";
    }
  }, []);

  const showOverlay = useCallback((type: "play" | "pause") => {
    const el = overlayRef.current;
    if (!el) return;
    el.dataset.type = type;
    el.style.display = "flex";
    el.style.animation = "none";
    void el.offsetHeight;
    el.style.animation = "";
    setTimeout(() => { if (overlayRef.current) overlayRef.current.style.display = "none"; }, 700);
  }, []);

  const setFastBadge = useCallback((visible: boolean) => {
    const el = fastBadgeRef.current;
    if (el) el.style.display = visible ? "block" : "none";
  }, []);

  // 直近 dispatch した progress を記憶しておき、差分が無視できるほど小さいときは
  // dispatch しない。BottomNav のシークバーは ~0.1% 単位で十分滑らかに見えるので、
  // 毎フレーム同値を投げて BottomNav の setState を 60fps 走らせる必要はない。
  // これにより、useFeedPlayback の rAF と BottomNav の setProgress の組み合わせ
  // による「Maximum update depth exceeded」誤検知を避ける。
  const lastDispatchedProgressRef = useRef(-1);

  const startProgressLoop = useCallback(() => {
    const tick = () => {
      const video = videoRef.current;
      if (!video || !isActiveRef.current) {
        rafRef.current = null;
        return;
      }
      // プロ女優スキップ有効時はシークバーの 0% を「下限 (5秒) 目」に対応させる。
      // 進捗 = (currentTime - lower) / (duration - lower)。
      // 通常動画 (lower = 0) はこれまでと同じ currentTime / duration。
      const dur = video.duration;
      const lower = skipLowerBoundRef.current;
      let progress = 0;
      if (Number.isFinite(dur) && dur > lower) {
        progress = (video.currentTime - lower) / (dur - lower);
        if (progress < 0) progress = 0;
        else if (progress > 1) progress = 1;
      }
      // 0.001 (= 0.1%) 未満の変化では dispatch しない。
      // 終端 (1.0) / 始端 (0.0) ちょうどへの遷移は確実に通す。
      const last = lastDispatchedProgressRef.current;
      const reachedEdge =
        (progress === 0 && last !== 0) || (progress === 1 && last !== 1);
      if (reachedEdge || Math.abs(progress - last) >= 0.001) {
        lastDispatchedProgressRef.current = progress;
        window.dispatchEvent(new CustomEvent("video-progress", { detail: { progress } }));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const stopProgressLoop = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // アンマウント時に rAF を必ず止める。<video> 要素が外れたあとも tick が
  // 走り続けると video-progress を空 dispatch し続けて BottomNav 側で
  // 不必要な setState を生むため。
  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ ratio: number }>;
      const video = videoRef.current;
      if (!video || !isActiveRef.current) return;
      const dur = video.duration;
      if (!Number.isFinite(dur) || dur <= 0) return;
      // シークバー座標系も「0% = lower 秒目 / 100% = 末尾」に統一する。
      // ratio はシークバー左端=0, 右端=1 で送られてくるので、
      //   target = lower + ratio * (dur - lower)
      // これにより通常動画 (lower=0) は従来通り ratio * dur。
      const lower = skipLowerBoundRef.current;
      const usableSpan = Math.max(0, dur - lower);
      const ratio = Math.max(0, Math.min(1, ce.detail.ratio));
      const target = lower + ratio * usableSpan;
      try {
        video.currentTime = Math.min(dur, target);
      } catch {
        /* seek 不可能なタイミングは無視 */
      }
    };
    window.addEventListener("video-seek", handler);
    return () => window.removeEventListener("video-seek", handler);
  }, []);

  const playVideo = useCallback(async (video: HTMLVideoElement, withGesture = false) => {
    if (withGesture) globalUserGestured = true;
    // ユーザーがミュート解除済みかどうかは globalIsMuted をソースオブトルースにする。
    // そうしないと、「見た目は unmuted なのに video 要素だけ muted=true」などの不整合が起きる。
    video.muted = globalIsMuted;
    isMutedRef.current = globalIsMuted;

    // プロ女優スキップが有効、かつまだ先頭 5 秒より前にいるなら、play() 直前に 5 秒へ飛ばす。
    // - 通常パス: skipLowerBoundRef.current (loadedmetadata 後に確定) を見て seek。
    // - 先行パス: skipLowerBoundRef.current がまだ確定していなくても、isProActress
    //   プロパティが true なら "先頭 5 秒以前で再生開始しない" 仕様確定なので、
    //   metadata 確定前でもベストエフォートで currentTime をセットしておく。
    //   loadedmetadata 前は currentTime セットがブラウザに無視されるが、確定後の
    //   handleLoadedMeta -> enforceLowerBound でもう一度クランプされるため二重防御になる。
    //   この先行 seek が無いと、play() を await している間 (= loadedmetadata 待ち)
    //   に「最初のフレーム = 0 秒目」が一瞬見えるブラウザ実装で、ユーザーから「5 秒
    //   スキップが効いていない」と見えるケースがあった。
    const lower = isProActressRef.current
      ? PRO_ACTRESS_HEAD_SKIP_SEC
      : skipLowerBoundRef.current;
    if (lower > 0) {
      if (Number.isFinite(video.duration) && video.duration > lower) {
        if (video.currentTime < lower) {
          try { video.currentTime = lower; } catch { /* ignore */ }
        }
      } else if (Number.isFinite(video.duration) && video.duration > 0) {
        // duration が判明していて、かつ lower より短いケース (= 短すぎる動画)。
        // この場合スキップは無効化する (= currentTime はそのまま)。
      } else {
        // duration がまだ NaN (loadedmetadata 前)。
        // 一部ブラウザは currentTime セットを silently accept してくれるので試す。
        // ダメだった場合は handleLoadedMeta → enforceLowerBound で巻き取られる。
        try { video.currentTime = lower; } catch { /* ignore */ }
      }
    }

    try {
      await video.play();
      isPlayingRef.current = true;
      startProgressLoop();
      return;
    } catch {
      /* unmuted 再生に失敗したら muted フォールバックに進む */
    }

    // フォールバック: この <video> だけ muted=true にして再生を試みる。
    // ここで重要なのは globalIsMuted を書き換えないこと。
    // 以前は autoplay policy / 動画のないスライド / ロード失敗などで一時的に play() が
    // reject されると globalIsMuted=true に戻されてしまい、スクロールしているうちに
    // ミュートが勝手に ON に戻るバグがあった。
    // (globalUserGestured は markFeedGesture によってスワイプごとに再設定される、
    //  また handleToggleMute で明示的に unmute された状態は保持しておきたい)
    video.muted = true;
    try {
      await video.play();
      isPlayingRef.current = true;
      startProgressLoop();
    } catch {
      // muted + playsInline でも autoplay 拒否されたケース。
      // dev 計測中はログだけ残す (UI は使える状態のままにする)。
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(`vt ${slug}: autoplay blocked (muted fallback rejected)`);
      }
    }
  }, [startProgressLoop, slug]);

  // 詳細モーダルを閉じたとき、現在アクティブなスライドなら再生を再開する。
  // （handleDetail で video.pause() しているため、モーダルを閉じても video は paused のままになるため）
  useEffect(() => {
    const onModalClose = () => {
      const video = videoRef.current;
      if (!video) return;
      if (!isActiveRef.current) return;
      if (video.paused) {
        // モーダルを開いて閉じる一連のユーザー操作をジェスチャーとみなして unmuted 再生を試みる
        playVideo(video, true);
      }
    };
    window.addEventListener("modal-close", onModalClose);
    return () => window.removeEventListener("modal-close", onModalClose);
  }, [playVideo]);

  // isActive を ref に同期させて、IntersectionObserver や modal-close / video-seek リスナーから
  // 最新の状態を参照できるようにする。
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // 親 (FeedViewer) で isActive=true になったタイミングで自動再生を試みる。
  // <video> 要素は isActive && currentSrc !== null のときだけマウントされるため、resolver で URL を遅延
  // 取得したケースでは isActive=true / videoSrc=URL になった時点でもまだ videoRef.current は null。
  // そのため deps に videoSrc に加えて videoElementVersion を含め、useLowFirstVideoSrc の
  // lowVideoCallbackRef が「null → 要素」遷移で notifyVideoElementChange() を呼んだ直後にも
  // effect を再実行させ、resolve 後の自動再生取りこぼしを防ぐ。
  // 同じ src での再マウントやスクロールでの再アクティブ化もこれでカバーされる。
  useEffect(() => {
    if (!isActive) return;
    if (!videoSrc) return;
    const video = videoRef.current;
    if (!video) return;
    isActiveRef.current = true;
    isMutedRef.current = globalIsMuted;
    setIsMuted(globalIsMuted);
    // 同期で muted 属性を反映してから play を呼ぶ
    video.muted = globalIsMuted;
    // 隣接スライド (isActive=false) で起きた onError は PR #91 以降無視しているため、
    // <video> が MediaError 状態のまま中央にスワイプしてくるケースがある。
    // MediaError 中の <video> は play() を呼んでも reject されるだけで再生できないため、
    // ここで video.load() を呼んで src を同じ URL で再ロードさせ、MediaError をリセットする。
    // load() は networkState=NETWORK_LOADING をキックするので　1 度ロード済みの bytes は
    // HTTP キャッシュ (Range リクエストの 206 レスポンス) から再利用される。
    if (video.error !== null) {
      try {
        video.load();
      } catch {
        /* load() 例外は握り潰し */
      }
    }
    // すでに再生中ならわざわざ play() を呼ばない (二重 play による rapid swipe loop を避ける)。
    if (!video.paused) {
      return;
    }
    playVideo(video, false);
  }, [isActive, videoSrc, playVideo, videoElementVersion]);

  // videoSrc が変わったとき (新しい <video> と同じだが src だけ差し替わったときも含む) は
  // hasPlayedRef を false にリセットして、初回ロード (loadstart) ではサムネを出せるようにする。
  useEffect(() => {
    hasPlayedRef.current = false;
  }, [videoSrc]);

  // アンマウント時にスピナー遅延タイマーをクリーンアップ。
  useEffect(() => {
    return () => {
      if (spinnerShowTimerRef.current != null) {
        clearTimeout(spinnerShowTimerRef.current);
        spinnerShowTimerRef.current = null;
      }
    };
  }, []);

  // isActive=false に切り替わったタイミングで video を停止・リセット。
  //
  // 隣接スライド (isAdjacent) では <video> がマウントされたまま以下の状態になる:
  //   - 初回マウント直後: opacity=0 (初期 style)、loadeddata で setVideoReady(true) が呼ばれて opacity=1 に
  //   - 中央→隣接遷移 (さっきまで中央で再生していた): この effect で停止に戻す
  //
  // 黒画面 + スピナーの一瞬挟まりを防ぐため、ここで setVideoReady(false) / setSpinnerVisible(true) は
  // 呼ばない (隣接スライドで opacity を 0 に戻すと、次に中央に来た瞬間 loadeddata/playing まで
  // 黒画面が見えてしまう)。スピナーは明示的に非表示にし、中央遷移後は waiting イベントで再表示される。
  useEffect(() => {
    if (isActive) return;
    const video = videoRef.current;
    isActiveRef.current = false;
    stopProgressLoop();
    if (video) {
      video.pause();
      video.currentTime = 0;
      video.playbackRate = 1;
      video.muted = globalIsMuted;
    }
    isPlayingRef.current = false;
    // shimmer は見せず、次回 loadstart まで非表示を維持。プリフェッチ済スライドで
    // スワイプした瞬間にサムネが一瞬見えるチラつきを避けるため。
    setShimmerVisible(false);
    // スピナーも隣接スライドでは非表示にしておく。中央に来た瞬間バッファ不足 (waiting)
    // が起きたら下の useEffect で setSpinnerVisible(true) される。
    setSpinnerVisible(false);
    setFastBadge(false);
    window.dispatchEvent(new CustomEvent("video-progress", { detail: { progress: 0 } }));
  }, [isActive, setShimmerVisible, setSpinnerVisible, setFastBadge, stopProgressLoop]);

  // props.isProActress を ref に同期。playVideo (useCallback) から最新値を参照できるようにする。
  // この同期は他の effect より先に走らせたいので、useLayoutEffect を使い、React 18 の
  // 同期コミット直後 (= 子の useEffect が走る前) に確実に書き込む。
  useEffect(() => {
    isProActressRef.current = isProActress;
  }, [isProActress]);

  // プロ女優スキップの確定処理。
  //
  // この effect は isActive に関わらず常に走る。隣接スライド (isAdjacent=true) で <video>
  // がマウントされているときにも loadedmetadata で currentTime=5 にシークしておいて、
  // スワイプで中央に来た瞬間即 5 秒地点のフレームが見えてから再生開始させるため。
  // (isActive=false で使うのは handleLoadedMeta / handleSeeking まで、ended/timeUpdate は isActive のみ無意味。
  //  ただしイベントリスナを貼るコストは軽いので、全て常にバインドして OK)
  // duration < MIN なら無効化 (短すぎる動画でホボ即終了するのを避ける)。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // この <video> 用の初期値リセット。
    // ただし isProActress=true のときは「duration がまだ分からなくてもとりあえず
    // 下限 = 5 秒として playVideo 等に伝える」ことで、loadedmetadata 確定前に play() を
    // 呼んだ場合でも先頭 5 秒以前から再生開始されるのを防ぐ。
    // duration 確定後 evaluate() で確認し、極端に短い動画 (< 10 秒) なら下限を 0 に戻す。
    skipEffectiveRef.current = isProActress;
    skipLowerBoundRef.current = isProActress ? PRO_ACTRESS_HEAD_SKIP_SEC : 0;

    const evaluate = () => {
      if (!isProActress) {
        skipEffectiveRef.current = false;
        skipLowerBoundRef.current = 0;
        return;
      }
      const dur = video.duration;
      if (!Number.isFinite(dur) || dur < PRO_ACTRESS_MIN_DURATION_SEC) {
        // メタデータ未確定 or 動画が短すぎる場合はスキップ無効
        skipEffectiveRef.current = false;
        skipLowerBoundRef.current = 0;
        return;
      }
      skipEffectiveRef.current = true;
      skipLowerBoundRef.current = PRO_ACTRESS_HEAD_SKIP_SEC;
    };

    const enforceLowerBound = () => {
      if (!skipEffectiveRef.current) return;
      const lower = skipLowerBoundRef.current;
      if (lower <= 0) return;
      // タイマー精度の都合で 4.9 のような値も来るので、わずかにマージンを取って判定する
      if (video.currentTime + 0.05 < lower) {
        if (isVideoTimingEnabled()) {
          // element 識別 (low / high / unknown) を含めて、どの <video> から
          // enforce が発火したかを後追いで切り分けられるようにする。
          // active=videoRef.current と一致するなら、再生中の要素が enforce 対象であり、
          // 一致しない場合は隣接スライドや swap 直後の旧要素 (= low) が発火源と分かる。
          const role = vtElementRole(video);
          const isActiveEl = videoRef.current === video;
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: pro-actress enforce element=${role}${isActiveEl ? "/active" : ""} currentTime=${video.currentTime.toFixed(2)} -> ${lower} paused=${video.paused} rs=${video.readyState}`,
          );
        }
        try { video.currentTime = lower; } catch { /* ignore */ }
      }
    };

    const handleLoadedMeta = () => {
      evaluate();
      // リトライ後のレジューム: 同 slug で直近の再生位置が記録されていれば、
      // その位置に currentTime をセットして「リトライしても最初からではなく途中から」とする。
      // プロ女優作品は下限 5 秒を超えている限りその位置を採用；超えていなければ enforceLowerBound で 5 秒に修正される。
      const dur = video.duration;
      if (
        lastPlaybackRef.current.slug === slug &&
        lastPlaybackRef.current.time > 0.5 &&
        Number.isFinite(dur) &&
        lastPlaybackRef.current.time < dur - 0.5
      ) {
        try { video.currentTime = lastPlaybackRef.current.time; } catch { /* ignore */ }
      }
      // メタデータ確定直後、初回再生はまだ 0 から始まっている可能性が高いので飛ばす。
      // これにより、isActive=false の隣接スライドでもプロ女優作品は 5 秒地点に
      // シークされ、そのフレームがプレビューとして表示される。
      enforceLowerBound();
    };
    const handleTimeUpdate = () => {
      // 同 slug 作品の再生位置を記録 (リトライ後に復帰させるため)。
      // 記録は isActive スライドのみ。隣接スライドは paused なので timeupdate はそもそも発火しないが念のため。
      if (isActiveRef.current) {
        lastPlaybackRef.current = { slug, time: video.currentTime };
      }
      enforceLowerBound();
    };
    const handleSeeking = () => enforceLowerBound();
    const handleSeeked = () => enforceLowerBound();
    const handleEnded = () => {
      // 既存ループ仕様 (HTMLVideoElement の loop 属性は未使用、再生終端で何が起きるかは
      // ブラウザ依存) に合わせ、明示的に 5 秒に戻して再生再開する。
      // isActive=false (隣接スライド) ではそもそも paused なので ended は退火しないが、念のためガード。
      if (!isActiveRef.current) return;
      if (!skipEffectiveRef.current) return;
      const lower = skipLowerBoundRef.current;
      try { video.currentTime = lower > 0 ? lower : 0; } catch { /* ignore */ }
      // loop 未設定でも再開させる。ユーザージェスチャーを失っていることが多いので muted フォールバックで OK。
      void playVideo(video, false);
    };

    // 初期評価 (もう metadata が読めていれば即評価)
    if (video.readyState >= 1) {
      evaluate();
      enforceLowerBound();
    }

    video.addEventListener("loadedmetadata", handleLoadedMeta);
    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("seeking", handleSeeking);
    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("ended", handleEnded);
    return () => {
      video.removeEventListener("loadedmetadata", handleLoadedMeta);
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("seeking", handleSeeking);
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("ended", handleEnded);
    };
  }, [slug, videoSrc, isProActress, playVideo, videoElementVersion]);

  // 再生中の読み込み停滞 (waiting/stalled) と、再生再開 (playing/canplaythrough) を検知して
  // スピナーの表示・非表示を切り替える。isActive 中のときだけビデオ要素が
  // 存在するため、それに依存したイベントリスナをその単位で貼り替える。
  //
  // 重要: dual-video スワップ (useLowFirstVideoSrc) で videoRef.current が
  // low → high に付け替わったときは、effect が再実行されて新しい high <video> に
  // 張り直す。ただし high はスワップ起動時点ですでに `playing` 状態になっており、
  // 再バインド後に追加で `playing` イベントが飛ぶ保証はない。そのため
  // 「再バインド時点の active 要素が既に再生中なら即座にスピナーを消す」
  // 同期チェックを必ず走らせる。これを入れないと、
  //   - スワップ前に low 側で waiting で出ていたスピナー
  //   - 初期 JSX の display:flex のまま残ったスピナー
  // が high 再生中に消えず、「音声はなっているのに画面はロード中」状態になる。
  useEffect(() => {
    if (!isActive) return;
    const video = videoRef.current;
    if (!video) return;

    const slugTag = isVideoTimingEnabled() ? slug : "";

    const handleWaiting = () => {
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(`vt ${slugTag}: spinner waiting (active el ts=${video.currentTime.toFixed(2)})`);
      }
      // シーク直後などにも発火するが、バッファが足りればすぐ playing で消えるので問題なし
      setSpinnerVisible(true);
    };
    const handlePlaying = () => {
      hasPlayedRef.current = true;
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(`vt ${slugTag}: spinner clear (playing on active el)`);
      }
      // 万一、起動タイミングで shimmer が見えていたら明示的に消しておく。
      const shimmer = shimmerRef.current;
      if (shimmer) shimmer.style.display = "none";
      setSpinnerVisible(false);
    };
    const handleCanPlayThrough = () => {
      setSpinnerVisible(false);
    };
    const handleStalled = () => {
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(`vt ${slugTag}: spinner stalled (active el)`);
      }
      // ネットワーク遅延でデータが来ないときもスピナーを出す
      setSpinnerVisible(true);
    };

    video.addEventListener("waiting", handleWaiting);
    video.addEventListener("playing", handlePlaying);
    video.addEventListener("canplaythrough", handleCanPlayThrough);
    video.addEventListener("stalled", handleStalled);

    // 再バインド時の同期チェック。
    // active 要素 (= 視覚的に表示中で音声を出す方) がすでに「実質再生中」なら
    // スピナーを必ず消す。dual-video スワップ後の高画質 <video> がここに該当する。
    //   - paused が false
    //   - readyState >= HAVE_CURRENT_DATA (= 2、現在の 1 フレームをデコード済み)
    // の両方を満たすときに即座にスピナーを消す。
    //
    // 逆に paused 中・readyState 不足のときは何もしない (waiting/stalled の通常経路に任せる)。
    if (!video.paused && video.readyState >= 2) {
      const shimmer = shimmerRef.current;
      if (shimmer) shimmer.style.display = "none";
      setSpinnerVisible(false);
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slugTag}: spinner clear on rebind (paused=${video.paused} rs=${video.readyState})`,
        );
      }
    }

    return () => {
      video.removeEventListener("waiting", handleWaiting);
      video.removeEventListener("playing", handlePlaying);
      video.removeEventListener("canplaythrough", handleCanPlayThrough);
      video.removeEventListener("stalled", handleStalled);
    };
  }, [isActive, setSpinnerVisible, videoElementVersion, slug]);

  // フォールバック: 念のため IntersectionObserver でも監視する。
  // (端末向きを変えたときや SSR ハイドレート直後など、isActive prop の同期前に発火するケースに備える)
  // videoSrc を deps に含めることで、resolver で URL が遅延取得され <video> が今マウントされた
  // ときにも observer を貼り直し、このフォールバック経路でも自動再生を起こせるようにしておく。
  //
  // 重要: isActive=false の隣接スライド (<video> を preload のためにマウントしているケース) では
  // observer で勝手に isActive 扱いにして再生してはいけない。isActive prop を source of truth とし、
  // observer は 「親がすでに isActive=true と見なしているが paused のとき」 に限って再生をトリガーする。
  useEffect(() => {
    if (!isActive) return;
    const video = videoRef.current;
    if (!video) return;
    const playObserver = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      if (!isActiveRef.current) return;
      if (video.paused) {
        // 既に active だが paused のとき (モーダル戻りなど) は再生再開
        playVideo(video, false);
      }
    }, { threshold: PLAY_THRESHOLD });
    playObserver.observe(video);
    return () => {
      playObserver.disconnect();
    };
  }, [playVideo, isActive, videoSrc]);

  // 長押しメニュー・右クリックメニューをフィードアイテム全体で拒否する。
  // 動画コンテナだけだと、サムネイルのみ表示中のスライドやボトムバーの押下でコンテキストメニューが出てしまうため、
  // section 全体に当てる。タッチや右クリック、iOS の長押し保存ダイアログをそもそも出さないようにする。
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const prevent = (e: Event) => e.preventDefault();
    el.addEventListener("contextmenu", prevent);
    return () => el.removeEventListener("contextmenu", prevent);
  }, []);

  const fireSkip = useCallback((clientX: number, clientY: number) => {
    const video   = videoRef.current;
    const section = sectionRef.current;
    if (!video || !section) return;
    const rect   = section.getBoundingClientRect();
    const isLeft = clientX - rect.left < rect.width / 2;
    // プロ女優スキップが有効なら 5 秒未満には絶対に戻らない (下限クランプ)
    const lower = skipLowerBoundRef.current;
    if (isLeft) video.currentTime = Math.max(lower, video.currentTime - SKIP_SEC);
    else        video.currentTime = Math.min(video.duration || Infinity, video.currentTime + SKIP_SEC);
    const ripple = document.createElement("div");
    ripple.className = "skip-ripple";
    ripple.style.left = `${clientX - rect.left}px`;
    ripple.style.top  = `${clientY - rect.top}px`;
    ripple.innerHTML  = `<span class="skip-icon">${isLeft ? "\u00ab -5s" : "+5s \u00bb"}</span>`;
    containerRef.current?.appendChild(ripple);
    setTimeout(() => ripple.remove(), 700);
  }, []);

  const fireTogglePlay = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      await playVideo(video, true);
      showOverlay("play");
    } else {
      video.pause();
      isPlayingRef.current = false;
      stopProgressLoop();
      showOverlay("pause");
    }
  }, [playVideo, showOverlay, stopProgressLoop]);

  const handleToggleMute = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const video = videoRef.current;
    if (!video) return;
    if (isMutedRef.current) {
      globalUserGestured = true;
      globalIsMuted = false;
      video.muted = false;
      isMutedRef.current = false;
      setIsMuted(false);
      if (video.paused) { video.play().catch(() => {}); isPlayingRef.current = true; startProgressLoop(); }
    } else {
      globalIsMuted = true;
      video.muted = true;
      isMutedRef.current = true;
      setIsMuted(true);
    }
    window.dispatchEvent(new Event("global-mute-change"));
  }, [startProgressLoop]);

  const handleShare = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    // navigator.share はユーザージェスチャーの同期コンテキストが必要なため
    // e.preventDefault() を呼ばない
    const url = `${window.location.origin}/feed?v=${slug}`;
    if (navigator.share) {
      navigator.share({ title, url }).catch(() => {});
    } else {
      navigator.clipboard.writeText(url).catch(() => {});
    }
  }, [slug, title]);

  const handleDetail = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const video = videoRef.current;
    if (video && !video.paused) {
      video.pause();
      isPlayingRef.current = false;
      stopProgressLoop();
    }
    onOpenModal(slug);
  }, [slug, onOpenModal, stopProgressLoop]);

  const startLongPress = useCallback(() => {
    isLongPressRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      const video = videoRef.current;
      if (!video) return;
      isLongPressRef.current = true;
      video.playbackRate = 2;
      setFastBadge(true);
    }, LONG_PRESS_MS);
  }, [setFastBadge]);

  const endLongPress = useCallback((): boolean => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    const video   = videoRef.current;
    const wasLong = isLongPressRef.current;
    if (wasLong && video) { video.playbackRate = 1; setFastBadge(false); isLongPressRef.current = false; }
    return wasLong;
  }, [setFastBadge]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!videoRef.current) return;
    isTouchDeviceRef.current = true;
    const touch = e.touches[0];
    tapStartPosRef.current = { x: touch.clientX, y: touch.clientY };
    startLongPress();
  }, [startLongPress]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!videoRef.current) return;
    const wasLong = endLongPress();
    if (wasLong) return;
    const touch = e.changedTouches[0];
    const { clientX, clientY } = touch;
    const dx = Math.abs(clientX - tapStartPosRef.current.x);
    const dy = Math.abs(clientY - tapStartPosRef.current.y);
    if (dx > TAP_MOVE_THRESHOLD || dy > TAP_MOVE_THRESHOLD) {
      tapCountRef.current = 0;
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
      return;
    }
    lastTouchEndRef.current = Date.now();
    tapCountRef.current += 1;
    if (tapCountRef.current === 1) {
      tapTimerRef.current = setTimeout(() => {
        if (tapCountRef.current === 1) fireTogglePlay();
        tapCountRef.current = 0;
      }, DBL_TAP_MS);
    } else if (tapCountRef.current >= 2) {
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
      tapCountRef.current = 0;
      fireSkip(clientX, clientY);
    }
  }, [endLongPress, fireTogglePlay, fireSkip]);

  const handleTouchCancel = useCallback(() => {
    endLongPress();
    tapCountRef.current = 0;
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
  }, [endLongPress]);

  const handleMouseDown = useCallback(() => {
    if (isTouchDeviceRef.current) return;
    startLongPress();
  }, [startLongPress]);

  const handleMouseUp = useCallback(() => {
    if (isTouchDeviceRef.current) return;
    const wasLong = endLongPress();
    if (wasLong) wasLongPressJustEndedRef.current = true;
  }, [endLongPress]);

  const handleMouseLeave = useCallback(() => {
    if (isTouchDeviceRef.current) return;
    const wasLong = endLongPress();
    if (wasLong) wasLongPressJustEndedRef.current = true;
  }, [endLongPress]);

  const handlePcClick = useCallback((e: React.MouseEvent) => {
    if (isTouchDeviceRef.current) return;
    if (Date.now() - lastTouchEndRef.current < 500) return;
    if (wasLongPressJustEndedRef.current) { wasLongPressJustEndedRef.current = false; return; }
    pcClickCountRef.current += 1;
    if (pcClickCountRef.current === 1) {
      pcClickTimerRef.current = setTimeout(() => {
        if (pcClickCountRef.current === 1) fireTogglePlay();
        pcClickCountRef.current = 0;
      }, DBL_TAP_MS);
    } else if (pcClickCountRef.current >= 2) {
      if (pcClickTimerRef.current) clearTimeout(pcClickTimerRef.current);
      pcClickCountRef.current = 0;
      fireSkip(e.clientX, e.clientY);
    }
  }, [fireTogglePlay, fireSkip]);

  return {
    videoRef,
    sectionRef,
    containerRef,
    shimmerRef,
    spinnerRef,
    fastBadgeRef,
    overlayRef,
    isMuted,
    setVideoReady,
    setShimmerVisible,
    setSpinnerVisible,
    handleToggleMute,
    handleShare,
    handleDetail,
    handleTouchStart,
    handleTouchEnd,
    handleTouchCancel,
    handleMouseDown,
    handleMouseUp,
    handleMouseLeave,
    handlePcClick,
    /**
     * dual-video スワップで `videoRef.current` の指す DOM 要素が変わった直後に
     * 呼び出すコールバック。プロ女優スキップ / 再生スピナー effect の deps を
     * 進めて再実行させ、新しい要素にイベントリスナを張り直す。
     */
    notifyVideoElementChange,
  };
}
