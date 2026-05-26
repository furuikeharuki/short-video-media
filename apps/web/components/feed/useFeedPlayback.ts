"use client";

import { useEffect, useRef, useCallback, useState } from "react";

import { createVideoTimer, isVideoTimingEnabled } from "@/lib/videoTiming";
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
  /**
   * handoff promote で host に append された <video> 要素。null の間は通常の
   * JSX `<video>` がマウントされており videoRef は React 側で設定される。
   * non-null になったタイミングで videoRef.current が promoted 要素に差し替わる
   * ため、active-autoplay effect の deps に含めて再走させ、自動再生を再起動する。
   */
  boundElement?: HTMLVideoElement | null;
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

export function useFeedPlayback({ slug, title, isActive, videoSrc, boundElement = null, onOpenModal, isProActress = false }: UseFeedPlaybackOptions) {
  // 初回マウント時に一回だけショートボタンフラグを消費
  consumeStartUnmutedFlag();

  const videoRef     = useRef<HTMLVideoElement>(null);
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

  // ユーザーが明示的にポーズしたかどうか。fireTogglePlay の pause / handleDetail (modal 開く)
  // で true、playVideo / modal-close での再開で false に戻す。
  // pro-actress minStart の seek 後 play() リトライで「ユーザーが止めた動画を勝手に再生再開しない」
  // ためのガード。
  const userPausedRef = useRef(false);
  // pro-actress minStart enforce で seek した直後、active かつ paused なら 1 回だけ play() を
  // 再試行するためのフラグ。seeked → (必要なら canplay) で消費する。
  // - true: 次の seeked / canplay で play retry をスケジュール
  // - false: リトライ不要 (= まだ enforce していない / すでにリトライ済み)
  // 同じ seek イベントで二重に発火させないため、リトライ実行時 / イベント受領時に即座に false に戻す。
  const proActressPlayRetryPendingRef = useRef(false);
  // play retry が「resolve したが playing が来ない」場合の最終フォールバック用 timer。
  // 1 回だけ video.play() を直接呼び直す。ループ防止のため使用後に必ず null に戻す。
  const proActressPlayFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // active autoplay intent の保留状態。
  //
  // 「active 化したが videoRef.current がまだ null (= 要素が bind されていない)」
  // ケースでは attemptActiveAutoplay は no-element で defer するだけだが、後で
  // boundElement / videoSrc が変わって effect が再走しても、useEffect commit 内で
  // videoRef.current が時間順に null → non-null になる微小な race
  // (FeedItemVideo の useLayoutEffect で host.appendChild + videoRef.current 設定
  // が走るタイミング、または handoff promote 直後にもう一度 React の commit を経る
  // ケース) で、ref が確定する前に early return → 二度と attempt されないことがある。
  //
  // この pending intent は「現 slug / videoSrc に対する autoplay を起動したい」を
  // 持ち越すための ref で、以下のいずれかで消費する:
  //   - boundElement が non-null になった直後の queueMicrotask
  //   - canplay / loadeddata / loadedmetadata イベント
  //   - readiness ベースのセーフティネット effect の同期チェック
  // 以下のいずれかで破棄する:
  //   - isActive=false / userPaused / detail open
  //   - slug / videoSrc 変更
  //   - unmount
  //   - 一度実行 (成否に関わらず) して消費
  // フィールドに slug/videoSrc を持たせて stale intent を弾く。
  const pendingActiveAutoplayRef = useRef<
    | { slug: string; videoSrc: string }
    | null
  >(null);

  // slug が変わったら lastPlaybackRef をリセット。同じ <video> 上で src が差し替わる force リトライのときだけ
  // 以前の位置を保持したいため、videoSrc 変化ではリセットしないことに注意。
  // 保留 autoplay intent も slug 変更で破棄する (前作品の intent が新 slug に持ち越されない)。
  useEffect(() => {
    if (lastPlaybackRef.current.slug !== slug) {
      lastPlaybackRef.current = { slug: "", time: 0 };
    }
    const intent = pendingActiveAutoplayRef.current;
    if (intent && intent.slug !== slug) {
      pendingActiveAutoplayRef.current = null;
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
        userPausedRef.current = false;
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
  // <video> 要素は isActive && videoSrc !== null のときだけマウントされるため、resolver
  // で URL を遅延取得したケースでも videoSrc を deps に含めることで、URL 到着・<video>
  // マウント直後に effect を再実行して自動再生を起動する。
  // 加えて、handoff promote で boundElement が後から差し替わるケースでも、
  // boundElement を deps に含めて effect を再走させて promoted 要素に対する play() を
  // 確実に呼ぶ。これが無いと「videoRef.current が null の commit で early return →
  // 直後の commit で videoRef が promoted 要素に書き換わるが effect 再走の契機が無い」
  // パスで autoplay が永久に走らない。
  //
  // attemptActiveAutoplay は active 化 / src 解決 / 要素 rebind / canplay / metadata の
  // どの経路で呼ばれても idempotent に「アクティブな <video> に対して 1 回 bounded
  // で play() を試みる」セマンティクスを提供する。abort / resolved / rejected を vt
  // ログに残す。
  const attemptActiveAutoplay = useCallback(
    (
      reason:
        | "active-change"
        | "promote"
        | "canplay"
        | "metadata"
        | "observer"
        | "element-bound",
    ) => {
      if (!isActiveRef.current) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(`vt ${slug}: active autoplay abort reason=inactive trigger=${reason}`);
        }
        return;
      }
      const video = videoRef.current;
      if (!video) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(`vt ${slug}: active autoplay abort reason=stale-element trigger=${reason}`);
        }
        return;
      }
      if (userPausedRef.current) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(`vt ${slug}: active autoplay abort reason=user-paused trigger=${reason}`);
        }
        return;
      }
      if (!video.paused) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: active autoplay abort reason=already-playing trigger=${reason} rs=${video.readyState}`,
          );
        }
        return;
      }
      // MediaError 状態を持ち越したまま中央にスワイプしてきた <video> は、play() が
      // reject されるだけで再生できないので src を同じ URL で再ロードさせて
      // MediaError をリセットする (HTTP キャッシュから 206 で再利用される)。
      if (video.error !== null) {
        try { video.load(); } catch { /* ignore */ }
      }
      isMutedRef.current = globalIsMuted;
      setIsMuted(globalIsMuted);
      video.muted = globalIsMuted;
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slug}: active autoplay start reason=${reason} paused=${video.paused} rs=${video.readyState} muted=${video.muted}`,
        );
      }
      // playVideo (= 既存の muted フォールバック / proActress 先頭 5 秒 seek 込み) に
      // そのまま委譲する。playVideo 内で resolve/reject は握り潰されているが、
      // vt 観測用には play() 自体を直接呼んで resolve/reject をログに残す。
      const playPromise = video.play();
      if (playPromise === undefined) {
        // 古い Safari など Promise を返さないブラウザの保険。
        isPlayingRef.current = true;
        startProgressLoop();
        return;
      }
      playPromise.then(
        () => {
          if (videoRef.current !== video) return;
          if (!isActiveRef.current) return;
          if (userPausedRef.current) return;
          isPlayingRef.current = true;
          startProgressLoop();
          if (isVideoTimingEnabled()) {
            // eslint-disable-next-line no-console
            console.debug(
              `vt ${slug}: active autoplay resolved reason=${reason} paused=${video.paused} rs=${video.readyState}`,
            );
          }
        },
        (err: unknown) => {
          const e = err as { name?: string; message?: string } | null;
          const name = e?.name ?? "Error";
          const message = e?.message ?? String(err);
          // play() の resolve/reject はマイクロタスクで遅延するため、ここに来た時点で
          // 既にスライドが非 active へ移っているケースがある (スワイプ直後の pause() で
          // AbortError が立つ等)。それを `rejected` として出すと「stale 状態の play
          // 失敗」と「現 active 状態の真の失敗」が同じ vt ラベルになってしまい、
          // 例えば直前 active 49ekdv... の AbortError が新 active 中の vt ログに
          // 混じり原因分析が困難になる。stale 系は別ラベル (`abort reason=stale-active`)
          // で短く出し、muted fallback も走らせない。
          const stale = !isActiveRef.current || videoRef.current !== video;
          if (isVideoTimingEnabled()) {
            if (stale) {
              // eslint-disable-next-line no-console
              console.debug(
                `vt ${slug}: active autoplay abort reason=stale-active trigger=${reason} name=${name}`,
              );
            } else {
              // eslint-disable-next-line no-console
              console.debug(
                `vt ${slug}: active autoplay rejected reason=${reason} name=${name} message=${message} paused=${video.paused} rs=${video.readyState}`,
              );
            }
          }
          // muted fallback。playVideo の中で muted=true → play() を 1 度だけ呼ぶ。
          // ループしないよう既に再生中 / 非 active / user-paused なら skip。
          if (stale) return;
          if (userPausedRef.current) return;
          if (!video.paused) return;
          void playVideo(video, false);
        },
      );
    },
    [playVideo, slug, startProgressLoop],
  );

  // pending intent を「現状の videoRef + 状態」で消費する。
  // 同じ slug/videoSrc に対して active かつ要素がある場合に限り、reason=element-bound で
  // attemptActiveAutoplay を呼ぶ。消費後は intent をクリアする (重複起動防止)。
  const tryConsumePendingActiveAutoplay = useCallback(
    (trigger: "element-bound" | "canplay" | "metadata" | "loadeddata") => {
      const intent = pendingActiveAutoplayRef.current;
      if (!intent) return;
      if (intent.slug !== slug) {
        // slug 変化で stale。捨てる。
        pendingActiveAutoplayRef.current = null;
        return;
      }
      if (intent.videoSrc !== videoSrc) {
        // videoSrc 差し替え (force リトライ等) でもこの intent は古い。
        pendingActiveAutoplayRef.current = null;
        return;
      }
      if (!isActiveRef.current) {
        pendingActiveAutoplayRef.current = null;
        return;
      }
      if (userPausedRef.current) {
        pendingActiveAutoplayRef.current = null;
        return;
      }
      const video = videoRef.current;
      if (!video) {
        // まだ要素が無い。intent は保持して次の機会を待つ。
        return;
      }
      // 消費。
      pendingActiveAutoplayRef.current = null;
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slug}: active autoplay start reason=element-bound trigger=${trigger} rs=${video.readyState} paused=${video.paused}`,
        );
      }
      // reason は "element-bound" に統一して、no-element defer のフォローアップが
      // 必ずこの label で観測できるようにする。attemptActiveAutoplay 内のログでは
      // この reason を使う。
      attemptActiveAutoplay("element-bound");
    },
    [attemptActiveAutoplay, slug, videoSrc],
  );

  // active-change / src 解決 / 要素 rebind (promoted swap) のいずれかで自動再生を起動。
  useEffect(() => {
    if (!isActive) return;
    if (!videoSrc) return;
    const video = videoRef.current;
    if (!video) {
      // この commit では videoRef がまだ null。boundElement が non-null に
      // 変化したときに deps 再評価で再走するが、commit 中に videoRef.current が
      // null→non-null になる race で再走後も null のまま early return するケースが
      // あるため、明示的な pending intent を立てておき、boundElement 変化後の
      // microtask / canplay 系イベント / 安全網 effect の同期チェックで消費する。
      pendingActiveAutoplayRef.current = { slug, videoSrc };
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slug}: active autoplay defer reason=no-element bound=${boundElement ? "set" : "null"}`,
        );
      }
      return;
    }
    isActiveRef.current = true;
    // 新しく active になったスライドは自動再生対象。前作品で残った userPausedRef は破棄する。
    userPausedRef.current = false;
    // 要素が今 bind されたので保留 intent はもう不要。
    pendingActiveAutoplayRef.current = null;
    // promote 由来 (boundElement non-null) と通常マウントを reason で区別する。
    // 同じ commit で promoted swap + active 化が起きるケースは promote 側を優先。
    attemptActiveAutoplay(boundElement ? "promote" : "active-change");
  }, [isActive, videoSrc, boundElement, attemptActiveAutoplay, slug]);

  // boundElement (= promoted 要素) が non-null になった commit では、子の
  // FeedItemVideo useLayoutEffect で videoRef.current が adopted 要素に書き換わる。
  // 親の useEffect (上の active-change effect) は子の useLayoutEffect より後に走る
  // ことが期待されるが、commit 順序や条件分岐で稀に「effect は走ったが ref はまだ
  // null」になるケースが観測されているため、追加の安全網としてここで
  // queueMicrotask を投げて pending intent を遅延消費する。microtask は同 commit の
  // 全 useLayoutEffect 終了後に走るので、ref 設定の取りこぼしを救う。
  useEffect(() => {
    if (!isActive) return;
    if (!videoSrc) return;
    if (!boundElement) return;
    if (!pendingActiveAutoplayRef.current) return;
    queueMicrotask(() => {
      tryConsumePendingActiveAutoplay("element-bound");
    });
  }, [isActive, videoSrc, boundElement, tryConsumePendingActiveAutoplay]);

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
      // 保留 autoplay intent もアンマウントで破棄。
      pendingActiveAutoplayRef.current = null;
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
    // 隣接スライドに戻ったので、まだ未消化の play retry 予約と userPaused 状態は破棄する
    // (次に中央に戻ったときは userPausedRef=false 起点で再評価される)。
    proActressPlayRetryPendingRef.current = false;
    if (proActressPlayFallbackTimerRef.current != null) {
      clearTimeout(proActressPlayFallbackTimerRef.current);
      proActressPlayFallbackTimerRef.current = null;
    }
    // active 化時の保留 autoplay intent も非アクティブで破棄する。
    pendingActiveAutoplayRef.current = null;
    userPausedRef.current = false;
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
        // 隣接スライド (isActive=false) かつ paused かつ readyState<=1 のケースは
        // 「adjacent プレビュー用に 5 秒へ seek」「アンマウント / 再初期化途中」など
        // 仕様どおりの seek でログが多くなり過ぎるためログだけ抑制する。
        // 実際の seek (lower-bound enforce) は active/inactive 問わず必要なのでそのまま実行する。
        // 一方、active 中の enforce はリトライ取りこぼし等の重要な signal なので必ずログ。
        const isQuietInactive =
          !isActiveRef.current && video.paused && video.readyState <= 1;
        if (isVideoTimingEnabled() && !isQuietInactive) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: pro-actress enforce currentTime=${video.currentTime.toFixed(2)} -> ${lower} paused=${video.paused} rs=${video.readyState} active=${isActiveRef.current}`,
          );
        }
        try { video.currentTime = lower; } catch { /* ignore */ }
        // active かつ autoplay 対象 (= ユーザーが明示的に止めていない) で、enforce 直後に
        // 動画が paused のままなら、seeked / canplay 後に一度だけ play() を再試行する。
        // ブラウザによっては play() を await した後の currentTime 設定で再生開始がキャンセル
        // されてしまい、結果として「5 秒に飛んだが paused のまま」になるケースがあるため。
        // 二重トリガー防止のため pending フラグで idempotent にしている。
        if (
          isActiveRef.current &&
          !userPausedRef.current &&
          video.paused
        ) {
          proActressPlayRetryPendingRef.current = true;
        }
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
    const tryConsumePlayRetry = (eventName: "seeked" | "canplay") => {
      if (!proActressPlayRetryPendingRef.current) return;
      // 現在の active 要素と slug にバインド。effect closure 内では video/slug は固定だが、
      // クリーンアップ前に新しい slug の <video> が active になっているケースに備えて
      // ref と突き合わせて stale を弾く。
      //
      // ただし「captured video はもう videoRef ではないが、現 active 要素が同じ
      // hook インスタンスの videoRef.current として存在し、active かつ paused」
      // のケースは、handoff promote 等で <video> が rebind されただけで slug 自体は
      // 変わっていない。この場合は単に「rebind 後の現要素」に対してリトライすべき。
      // useFeedPlayback は slug 1 件につき 1 度マウントされる (FeedItem の key に slug が
      // 紐付くため) 仕様のため、effect closure の `slug` と現状の slug は同一であり、
      // videoRef.current が non-null である限り「同 slug の現 active 要素」として
      // 扱える。
      let target: HTMLVideoElement | null = video;
      if (videoRef.current !== video) {
        const current = videoRef.current;
        if (
          current &&
          isActiveRef.current &&
          !userPausedRef.current &&
          current.paused
        ) {
          if (isVideoTimingEnabled()) {
            // eslint-disable-next-line no-console
            console.debug(
              `vt ${slug}: pro-actress play retry rebind stale-element -> current-element on=${eventName} rs=${current.readyState}`,
            );
          }
          target = current;
        } else {
          if (isVideoTimingEnabled()) {
            // eslint-disable-next-line no-console
            console.debug(
              `vt ${slug}: pro-actress play retry abort reason=stale-element on=${eventName}`,
            );
          }
          proActressPlayRetryPendingRef.current = false;
          return;
        }
      }
      if (!isActiveRef.current) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: pro-actress play retry abort reason=inactive on=${eventName}`,
          );
        }
        proActressPlayRetryPendingRef.current = false;
        return;
      }
      if (userPausedRef.current) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: pro-actress play retry abort reason=user-paused on=${eventName}`,
          );
        }
        proActressPlayRetryPendingRef.current = false;
        return;
      }
      if (!target.paused) {
        // すでに再生中。リトライ不要。
        proActressPlayRetryPendingRef.current = false;
        return;
      }
      // pending を先に消費しておく。playVideo 側で seek が再度発火しても
      // ループしないように idempotent にする。
      proActressPlayRetryPendingRef.current = false;

      const playTarget = target;
      const pausedBefore = playTarget.paused;
      const rsBefore = playTarget.readyState;
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slug}: pro-actress play retry start reason=${eventName} paused=${pausedBefore} rs=${rsBefore}`,
        );
      }

      // 直接 playTarget.play() を呼び、resolve/reject を必ずログに残す。
      // playVideo を経由しないのは:
      //   - 既に lower bound seek 済みなのでもう一度 seek する必要がない
      //   - play() の resolve/reject を観測したいので catch を握り潰さない
      // 失敗時のみ muted fallback として playVideo にエスカレートする。
      playTarget.muted = globalIsMuted;
      const playPromise = playTarget.play();
      if (playPromise === undefined) {
        // 古い Safari など Promise を返さないブラウザの保険。
        // 状態だけ更新して fallback timer に委ねる。
        isPlayingRef.current = true;
        startProgressLoop();
      } else {
        playPromise.then(
          () => {
            if (videoRef.current !== playTarget) return;
            if (!isActiveRef.current) return;
            if (userPausedRef.current) return;
            isPlayingRef.current = true;
            startProgressLoop();
            if (isVideoTimingEnabled()) {
              // eslint-disable-next-line no-console
              console.debug(
                `vt ${slug}: pro-actress play retry resolved paused=${playTarget.paused} rs=${playTarget.readyState}`,
              );
            }
          },
          (err: unknown) => {
            const e = err as { name?: string; message?: string } | null;
            const name = e?.name ?? "Error";
            const message = e?.message ?? String(err);
            if (isVideoTimingEnabled()) {
              // eslint-disable-next-line no-console
              console.debug(
                `vt ${slug}: pro-actress play retry rejected name=${name} message=${message} paused=${playTarget.paused} rs=${playTarget.readyState}`,
              );
            }
            // NotAllowedError は autoplay policy。muted fallback に 1 回だけ落として終わる。
            // それ以外も握らず muted fallback に進む (どのみち失敗するなら 1 回 muted を試して諦める)。
            if (videoRef.current !== playTarget) return;
            if (!isActiveRef.current) return;
            if (userPausedRef.current) return;
            if (!playTarget.paused) return;
            void playVideo(playTarget, false);
          },
        );
      }

      // play() が resolve しても playing イベントが来ないケース (一部ブラウザで
      // currentTime 直前変更後に発生) の最終保険。bounded で 1 回だけ direct play() を
      // 呼び直す。ループ防止のため timer は使用後に必ず null。
      if (proActressPlayFallbackTimerRef.current != null) {
        clearTimeout(proActressPlayFallbackTimerRef.current);
      }
      const PLAY_RETRY_FALLBACK_MS = 800;
      proActressPlayFallbackTimerRef.current = setTimeout(() => {
        proActressPlayFallbackTimerRef.current = null;
        if (videoRef.current !== playTarget) return;
        if (!isActiveRef.current) return;
        if (userPausedRef.current) return;
        if (!playTarget.paused) return; // 既に再生中なら何もしない
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: pro-actress play retry fallback direct play paused=${playTarget.paused} rs=${playTarget.readyState}`,
          );
        }
        const p = playTarget.play();
        if (p && typeof p.then === "function") {
          p.then(
            () => {
              if (isVideoTimingEnabled()) {
                // eslint-disable-next-line no-console
                console.debug(
                  `vt ${slug}: pro-actress play retry fallback resolved paused=${playTarget.paused} rs=${playTarget.readyState}`,
                );
              }
            },
            (err: unknown) => {
              const e = err as { name?: string; message?: string } | null;
              if (isVideoTimingEnabled()) {
                // eslint-disable-next-line no-console
                console.debug(
                  `vt ${slug}: pro-actress play retry fallback rejected name=${e?.name ?? "Error"} message=${e?.message ?? String(err)}`,
                );
              }
              // ここで止める。これ以上は再試行しない (autoplay policy / 端末側の制約)。
            },
          );
        }
      }, PLAY_RETRY_FALLBACK_MS);
    };
    const handleSeeked = () => {
      enforceLowerBound();
      tryConsumePlayRetry("seeked");
    };
    const handleCanPlay = () => {
      tryConsumePlayRetry("canplay");
    };
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
    video.addEventListener("canplay", handleCanPlay);
    video.addEventListener("ended", handleEnded);
    return () => {
      video.removeEventListener("loadedmetadata", handleLoadedMeta);
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("seeking", handleSeeking);
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("canplay", handleCanPlay);
      video.removeEventListener("ended", handleEnded);
      // 次の <video> インスタンスに pending 状態が漏れないようリセット。
      proActressPlayRetryPendingRef.current = false;
      if (proActressPlayFallbackTimerRef.current != null) {
        clearTimeout(proActressPlayFallbackTimerRef.current);
        proActressPlayFallbackTimerRef.current = null;
      }
    };
  }, [slug, videoSrc, isProActress, playVideo, startProgressLoop]);

  // 自動再生のセーフティネット: active な要素が canplay / loadeddata / loadedmetadata
  // に到達した時点でまだ paused かつ user-paused でないなら、attemptActiveAutoplay を
  // 再起動する。これにより:
  //   - 「active-change effect で play() を呼んだが readyState 不足で reject
  //     された」ようなケースで、後発の canplay で確実に再試行できる。
  //   - 「proActress 経路は走らない (non-proActress 作品)」のに promoted swap
  //     直後に readyState が一時的に下がるエッジケースでも canplay で復帰できる。
  //   - 直接 video.play() を呼ぶので autoplay policy 拒否は active autoplay rejected
  //     としてログに出る (silent fail を防ぐ)。
  // proActress の play-retry とは reason が独立しており、両者が同 commit に走っても
  // playPromise の早期 abort ガード (paused / userPaused / stale-element) で安全に
  // idempotent。
  useEffect(() => {
    if (!isActive) return;
    if (!videoSrc) return;
    const video = videoRef.current;
    if (!video) return;
    const handle = (
      reason: "canplay" | "metadata",
      pendingTrigger: "canplay" | "metadata" | "loadeddata",
    ) => () => {
      if (!isActiveRef.current) return;
      if (userPausedRef.current) return;
      if (!video.paused) return;
      // 先に保留 intent を消費する。これは attemptActiveAutoplay と同じ video 要素 +
      // active/userPaused 条件を見るので順序依存はないが、reason=element-bound ラベルを
      // 確実に残すために先に呼ぶ。intent が無ければ何も起きないので idempotent。
      tryConsumePendingActiveAutoplay(pendingTrigger);
      attemptActiveAutoplay(reason);
    };
    const onCanPlay = handle("canplay", "canplay");
    const onLoadedData = handle("canplay", "loadeddata");
    const onLoadedMeta = handle("metadata", "metadata");
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("loadeddata", onLoadedData);
    video.addEventListener("loadedmetadata", onLoadedMeta);
    // 再バインド直後 (= promoted swap) で既に readyState >= 2 / 3 ならイベントが
    // 来ない可能性が高いので同期チェックして trigger。microtask で送ることで
    // 親 layout effect の videoRef 書き込みが確実に終わってから走る。
    if (video.paused && !userPausedRef.current) {
      const rs = video.readyState;
      if (rs >= 3) {
        queueMicrotask(() => {
          if (!isActiveRef.current) return;
          if (userPausedRef.current) return;
          if (!video.paused) return;
          if (videoRef.current !== video) return;
          tryConsumePendingActiveAutoplay("canplay");
          attemptActiveAutoplay("canplay");
        });
      } else if (rs >= 1) {
        queueMicrotask(() => {
          if (!isActiveRef.current) return;
          if (userPausedRef.current) return;
          if (!video.paused) return;
          if (videoRef.current !== video) return;
          tryConsumePendingActiveAutoplay("metadata");
          attemptActiveAutoplay("metadata");
        });
      }
    }
    return () => {
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("loadedmetadata", onLoadedMeta);
    };
  }, [isActive, videoSrc, boundElement, attemptActiveAutoplay, tryConsumePendingActiveAutoplay]);

  // 再生中の読み込み停滞 (waiting/stalled) と、再生再開 (playing/canplaythrough) を検知して
  // スピナーの表示・非表示を切り替える。isActive 中のときだけビデオ要素が
  // 存在するため、それに依存したイベントリスナをその単位で貼り替える。
  // 再バインド時点で既に再生中ならスピナーを即消ししておく。
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
    // paused=false かつ readyState >= HAVE_CURRENT_DATA (=2) なら即スピナーを消す。
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
  }, [isActive, setSpinnerVisible, slug]);

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
      if (userPausedRef.current) return;
      if (video.paused) {
        // 既に active だが paused のとき (モーダル戻りなど) は再生再開
        attemptActiveAutoplay("observer");
      }
    }, { threshold: PLAY_THRESHOLD });
    playObserver.observe(video);
    return () => {
      playObserver.disconnect();
    };
  }, [attemptActiveAutoplay, isActive, videoSrc, boundElement]);

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
      userPausedRef.current = false;
      await playVideo(video, true);
      showOverlay("play");
    } else {
      userPausedRef.current = true;
      // 一時停止と同時に minStart seek 後の play リトライ予約も破棄する。
      proActressPlayRetryPendingRef.current = false;
      if (proActressPlayFallbackTimerRef.current != null) {
        clearTimeout(proActressPlayFallbackTimerRef.current);
        proActressPlayFallbackTimerRef.current = null;
      }
      // ユーザー pause で保留 autoplay intent も破棄する。
      pendingActiveAutoplayRef.current = null;
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
      userPausedRef.current = true;
      proActressPlayRetryPendingRef.current = false;
      if (proActressPlayFallbackTimerRef.current != null) {
        clearTimeout(proActressPlayFallbackTimerRef.current);
        proActressPlayFallbackTimerRef.current = null;
      }
      // detail open でも保留 autoplay intent は破棄。
      pendingActiveAutoplayRef.current = null;
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
  };
}
