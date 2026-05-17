"use client";

import { useEffect, useRef, useCallback, useState } from "react";

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
  onOpenModal: (slug: string) => void;
}

export function useFeedPlayback({ slug, title, isActive, onOpenModal }: UseFeedPlaybackOptions) {
  // 初回マウント時に一回だけショートボタンフラグを消費
  consumeStartUnmutedFlag();

  const videoRef     = useRef<HTMLVideoElement>(null);
  const sectionRef   = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shimmerRef   = useRef<HTMLDivElement>(null);
  const fastBadgeRef = useRef<HTMLDivElement>(null);
  const overlayRef   = useRef<HTMLDivElement>(null);
  const rafRef       = useRef<number | null>(null);
  const isActiveRef  = useRef(false);

  const isPlayingRef             = useRef(false);
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

  const setVideoReady = useCallback((ready: boolean) => {
    const video   = videoRef.current;
    const shimmer = shimmerRef.current;
    if (video)   video.style.opacity   = ready ? "1" : "0";
    if (shimmer) shimmer.style.display = ready ? "none" : "block";
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

  const startProgressLoop = useCallback(() => {
    const tick = () => {
      const video = videoRef.current;
      if (!video || !isActiveRef.current) return;
      const progress = video.duration > 0 ? video.currentTime / video.duration : 0;
      window.dispatchEvent(new CustomEvent("video-progress", { detail: { progress } }));
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

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ ratio: number }>;
      const video = videoRef.current;
      if (!video || !isActiveRef.current) return;
      const dur = video.duration;
      if (!Number.isFinite(dur) || dur <= 0) return;
      const target = Math.max(0, Math.min(dur, ce.detail.ratio * dur));
      try {
        video.currentTime = target;
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
    } catch { /* ignore */ }
  }, [startProgressLoop]);

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
  // <video> 要素は isActive=true のときだけマウントされるので、ここで videoRef.current は
  // マウント直後に存在するようになる。effect の deps に isActive を含めることで、
  // 再マウントごとに新しい video 要素に対して playVideo が呼ばれる。
  useEffect(() => {
    if (!isActive) return;
    const video = videoRef.current;
    if (!video) return;
    isActiveRef.current = true;
    isMutedRef.current = globalIsMuted;
    setIsMuted(globalIsMuted);
    // 同期で muted 属性を反映してから play を呼ぶ
    video.muted = globalIsMuted;
    playVideo(video, false);
  }, [isActive, playVideo]);

  // isActive=false に切り替わったタイミングで video を停止・リセット。
  // <video> 要素自体はこの直後にアンマウントされるが、進捗 UI のリセットも兼ねる。
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
    setVideoReady(false);
    setFastBadge(false);
    window.dispatchEvent(new CustomEvent("video-progress", { detail: { progress: 0 } }));
  }, [isActive, setVideoReady, setFastBadge, stopProgressLoop]);

  // フォールバック: 念のため IntersectionObserver でも監視する。
  // (端末向きを変えたときや SSR ハイドレート直後など、isActive prop の同期前に発火するケースに備える)
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const playObserver = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        if (!isActiveRef.current) {
          isActiveRef.current = true;
          isMutedRef.current = globalIsMuted;
          setIsMuted(globalIsMuted);
          playVideo(video, false);
        } else if (video.paused) {
          // 既に active だが paused のとき (モーダル戻りなど) は再生再開
          playVideo(video, false);
        }
      }
    }, { threshold: PLAY_THRESHOLD });
    playObserver.observe(video);
    return () => {
      playObserver.disconnect();
    };
  }, [playVideo, isActive]);

  useEffect(() => {
    const el = containerRef.current;
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
    if (isLeft) video.currentTime = Math.max(0, video.currentTime - SKIP_SEC);
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
    fastBadgeRef,
    overlayRef,
    isMuted,
    setVideoReady,
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
