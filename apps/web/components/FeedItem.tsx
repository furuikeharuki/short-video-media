"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import Link from "next/link";
import type { MovieCard } from "@/lib/api/feed";

interface Props {
  item: MovieCard;
  isFirst: boolean;
  isSecond?: boolean;
}

const H_PADDING = 4;
const V_PADDING_TOP = 4;
const SKIP_SEC = 5;
const DBL_TAP_MS = 300;
const LONG_PRESS_MS = 500;
const TAP_MOVE_THRESHOLD = 10;
const PLAY_THRESHOLD = 0.85;
const PRELOAD_THRESHOLD = 0.01;

const isLandscapeScreen = () => window.innerWidth > window.innerHeight;

let globalUserGestured = false;

export default function FeedItem({ item, isFirst, isSecond = false }: Props) {
  const videoRef        = useRef<HTMLVideoElement>(null);
  const sectionRef      = useRef<HTMLElement>(null);
  const containerRef    = useRef<HTMLDivElement>(null);
  const infoOverlayRef  = useRef<HTMLDivElement>(null);
  const shimmerRef      = useRef<HTMLDivElement>(null);
  const pauseBadgeRef   = useRef<HTMLDivElement>(null);
  const fastBadgeRef    = useRef<HTMLDivElement>(null);
  const muteBadgeRef    = useRef<HTMLDivElement>(null);
  const overlayRef      = useRef<HTMLDivElement>(null);

  const preloadStartedRef        = useRef(false);
  const objectFitRef             = useRef<"cover" | "contain">("cover");
  const isPlayingRef             = useRef(false);
  const isMutedRef               = useRef(true);

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

  const [hintVisible, setHintVisible] = useState(isFirst);

  // info-overlay の高さを --info-h として section に書き込む
  useEffect(() => {
    const info = infoOverlayRef.current;
    const section = sectionRef.current;
    if (!info || !section) return;
    const update = () => {
      section.style.setProperty("--info-h", `${info.offsetHeight}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(info);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!isFirst) return;
    const container = document.querySelector(".feed-container");
    if (!container) return;
    const hide = () => setHintVisible(false);
    container.addEventListener("scroll", hide, { once: true, passive: true });
    return () => container.removeEventListener("scroll", hide);
  }, [isFirst]);

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

  const setPauseBadge = useCallback((visible: boolean) => {
    const el = pauseBadgeRef.current;
    if (el) el.style.display = visible ? "flex" : "none";
  }, []);

  const setFastBadge = useCallback((visible: boolean) => {
    const el = fastBadgeRef.current;
    if (el) el.style.display = visible ? "block" : "none";
  }, []);

  const setMuteBadge = useCallback((visible: boolean) => {
    const el = muteBadgeRef.current;
    if (el) el.style.display = visible ? "flex" : "none";
  }, []);

  // objectFit を映像アスペクト比に応じて切り替える（CSS変数 --obj-fit で video に反映）
  const applyObjectFit = useCallback((fit: "cover" | "contain") => {
    objectFitRef.current = fit;
    const video = videoRef.current;
    if (!video) return;
    video.style.objectFit = fit;
    video.style.objectPosition = fit === "contain" ? "center 30%" : "center center";
  }, []);

  const handleMetadata = useCallback(() => {
    const video   = videoRef.current;
    const section = sectionRef.current;
    if (!video || !section) return;
    let fit: "cover" | "contain";
    if (isLandscapeScreen()) {
      fit = "contain";
    } else {
      const videoAspect  = video.videoWidth / video.videoHeight;
      const screenAspect = section.offsetWidth / section.offsetHeight;
      fit = videoAspect <= screenAspect ? "cover" : "contain";
    }
    applyObjectFit(fit);
  }, [applyObjectFit]);

  const playVideo = useCallback(async (video: HTMLVideoElement, withGesture = false) => {
    if (withGesture) globalUserGestured = true;
    if (globalUserGestured) {
      video.muted = false;
      isMutedRef.current = false;
      setMuteBadge(false);
      try {
        await video.play();
        isPlayingRef.current = true;
        setPauseBadge(false);
        return;
      } catch { /* fall through to muted */ }
    }
    video.muted = true;
    isMutedRef.current = true;
    try {
      await video.play();
      isPlayingRef.current = true;
      setPauseBadge(false);
      setMuteBadge(true);
    } catch { /* ignore */ }
  }, [setMuteBadge, setPauseBadge]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const preloadObserver = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !preloadStartedRef.current) {
        preloadStartedRef.current = true;
        if (video.preload === "none") { video.preload = "auto"; video.load(); }
      }
    }, { threshold: PRELOAD_THRESHOLD });

    const playObserver = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        playVideo(video, false);
      } else {
        video.pause();
        video.currentTime = 0;
        video.playbackRate = 1;
        video.muted = true;
        isPlayingRef.current = false;
        isMutedRef.current   = true;
        setVideoReady(false);
        setPauseBadge(false);
        setFastBadge(false);
        setMuteBadge(false);
      }
    }, { threshold: PLAY_THRESHOLD });

    preloadObserver.observe(video);
    playObserver.observe(video);
    return () => { preloadObserver.disconnect(); playObserver.disconnect(); };
  }, [playVideo, setVideoReady, setPauseBadge, setFastBadge, setMuteBadge, isFirst, isSecond]);

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
    const rect  = section.getBoundingClientRect();
    const isLeft = clientX - rect.left < rect.width / 2;
    if (isLeft) video.currentTime = Math.max(0, video.currentTime - SKIP_SEC);
    else        video.currentTime = Math.min(video.duration || Infinity, video.currentTime + SKIP_SEC);

    const ripple = document.createElement("div");
    ripple.className = "skip-ripple";
    ripple.style.left = `${clientX - rect.left}px`;
    ripple.style.top  = `${clientY - rect.top}px`;
    ripple.innerHTML  = `<span class="skip-icon">${isLeft ? "« -5s" : "+5s »"}</span>`;
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
      setPauseBadge(true);
      showOverlay("pause");
    }
  }, [playVideo, showOverlay, setPauseBadge]);

  const handleUnmute = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const video = videoRef.current;
    if (!video) return;
    globalUserGestured = true;
    video.muted = false;
    isMutedRef.current = false;
    setMuteBadge(false);
    if (video.paused) { video.play().catch(() => {}); isPlayingRef.current = true; setPauseBadge(false); }
  }, [setMuteBadge, setPauseBadge]);

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

  const handleMouseUpWithFlag = useCallback(() => {
    if (isTouchDeviceRef.current) return;
    const wasLong = endLongPress();
    if (wasLong) wasLongPressJustEndedRef.current = true;
  }, [endLongPress]);

  const handleMouseLeaveWithFlag = useCallback(() => {
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

  const preloadAttr = isFirst || isSecond ? "auto" : "none";

  return (
    <section ref={sectionRef} className="feed-item" data-movie-id={item.id}>
      {item.sample_movie_url ? (
        <div
          ref={containerRef}
          className="video-bg video-bg--interactive"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchCancel}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUpWithFlag}
          onMouseLeave={handleMouseLeaveWithFlag}
          onClick={handlePcClick}
        >
          <div ref={shimmerRef} className="shimmer" aria-hidden="true">
            <div className="shimmer-inner" />
          </div>

          {/* 動画: top/left/right/bottom を CSS変数で制御 */}
          <video
            ref={videoRef}
            src={item.sample_movie_url}
            muted
            loop
            playsInline
            preload={preloadAttr}
            onLoadedMetadata={handleMetadata}
            onLoadedData={() => setVideoReady(true)}
            onCanPlay={() => setVideoReady(true)}
            className="feed-video"
            style={{ opacity: 0 }}
          />

          {/* 再生/停止オーバーレイ: 動画エリアと同じ領域に重ねる */}
          <div className="video-area-overlay">
            <div ref={overlayRef} className="action-overlay" aria-hidden="true" style={{ display: "none" }}>
              <span className="action-icon action-icon--pause" style={{ display: "none" }}>
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                  <rect x="12" y="8" width="10" height="32" rx="2" fill="white"/>
                  <rect x="26" y="8" width="10" height="32" rx="2" fill="white"/>
                </svg>
              </span>
              <span className="action-icon action-icon--play" style={{ display: "none" }}>
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                  <path d="M14 8L40 24L14 40V8Z" fill="white"/>
                </svg>
              </span>
            </div>

            <div ref={pauseBadgeRef} className="pause-badge" aria-hidden="true" style={{ display: "none" }}>
              <svg width="40" height="40" viewBox="0 0 48 48" fill="none">
                <rect x="12" y="8" width="10" height="32" rx="2" fill="white"/>
                <rect x="26" y="8" width="10" height="32" rx="2" fill="white"/>
              </svg>
            </div>
          </div>

          <div ref={fastBadgeRef} className="fast-badge" aria-hidden="true" style={{ display: "none" }}>2×</div>

          <div
            ref={muteBadgeRef}
            className="mute-badge"
            aria-label="タップしてミュート解除"
            role="button"
            style={{ display: "none" }}
            onTouchStart={(e) => e.stopPropagation()}
            onTouchEnd={handleUnmute}
            onClick={handleUnmute}
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
              <path d="M11 5L6 9H2v6h4l5 4V5z" fill="white"/>
              <line x1="23" y1="9" x2="17" y2="15" stroke="white" strokeWidth="2.2" strokeLinecap="round"/>
              <line x1="17" y1="9" x2="23" y2="15" stroke="white" strokeWidth="2.2" strokeLinecap="round"/>
            </svg>
            <span className="mute-label">タップで音声ON</span>
          </div>
        </div>
      ) : (
        <div className="thumbnail-bg">
          <img
            src={item.image_url_large ?? item.image_url_list ?? ""}
            alt={item.title}
            className="thumbnail-img"
            loading={isFirst ? "eager" : "lazy"}
            width={720}
            height={1280}
          />
        </div>
      )}

      {/* info-overlay の高さが --info-h として section に反映され、動画エリアが追従する */}
      <div ref={infoOverlayRef} className="info-overlay">
        <div className="genre-list">
          {item.genres.map((g) => <span key={g} className="genre-badge">{g}</span>)}
        </div>
        <h2 className="item-title">{item.title}</h2>
        {item.actresses.length > 0 && (
          <p className="item-actress">👤 {item.actresses.join(" / ")}</p>
        )}
        <div className="cta-buttons">
          <Link href={`/movies/${item.slug}`} className="btn-detail" prefetch={false}>
            詳細を見る
          </Link>
          <a href={item.affiliate_url} target="_blank" rel="noopener noreferrer" className="btn-buy">
            購入する →
          </a>
        </div>
      </div>

      {isFirst && (
        <div className={`scroll-hint${hintVisible ? "" : " scroll-hint--hidden"}`} aria-hidden="true">
          <span>スワイプ</span>
          <span className="scroll-arrow">↓</span>
        </div>
      )}

      <style>{itemStyle}</style>
    </section>
  );
}

const itemStyle = `
  /* --info-h は JS の ResizeObserver が section に書き込む。
     フォールバック値 160px はおおよその初期値。 */

  .feed-video {
    position: absolute;
    top: ${V_PADDING_TOP}px;
    left: ${H_PADDING}px;
    right: ${H_PADDING}px;
    bottom: calc(var(--info-h, 160px) + 8px);
    width: auto;
    height: auto;
    /* width/height を auto にして top/left/right/bottom で領域を確定させる */
    min-width: calc(100% - ${H_PADDING * 2}px);
    min-height: 0;
    object-fit: cover;
    object-position: center center;
    border-radius: 8px;
    transition: opacity 0.3s ease;
  }

  /* shimmer も動画と同じ領域をカバー */
  .shimmer {
    position: absolute;
    top: ${V_PADDING_TOP}px;
    left: ${H_PADDING}px;
    right: ${H_PADDING}px;
    bottom: calc(var(--info-h, 160px) + 8px);
    background: #1a1a1a;
    z-index: 1;
    overflow: hidden;
    border-radius: 8px;
  }
  .shimmer-inner {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      105deg,
      transparent 40%,
      rgba(255,255,255,0.06) 50%,
      transparent 60%
    );
    background-size: 200% 100%;
    animation: shimmer-slide 1.4s ease-in-out infinite;
  }
  @keyframes shimmer-slide {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  .video-bg--interactive {
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    tap-highlight-color: transparent;
    -webkit-touch-callout: none;
    user-select: none;
    touch-action: pan-y;
  }

  /* 動画エリアと完全に同じ領域をカバーするオーバーレイラッパー */
  .video-area-overlay {
    position: absolute;
    top: ${V_PADDING_TOP}px;
    left: ${H_PADDING}px;
    right: ${H_PADDING}px;
    bottom: calc(var(--info-h, 160px) + 8px);
    pointer-events: none;
    z-index: 25;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .action-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    animation: overlay-pop 0.65s ease-out forwards;
  }
  .action-icon {
    align-items: center;
    justify-content: center;
    filter: drop-shadow(0 2px 8px rgba(0,0,0,0.7));
  }
  .action-overlay[data-type="pause"] .action-icon--pause { display: flex !important; }
  .action-overlay[data-type="play"]  .action-icon--play  { display: flex !important; }
  @keyframes overlay-pop {
    0%   { opacity: 1; transform: scale(0.7); }
    30%  { opacity: 1; transform: scale(1.1); }
    70%  { opacity: 0.8; transform: scale(1); }
    100% { opacity: 0; transform: scale(1); }
  }

  .pause-badge {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.7;
    pointer-events: none;
    filter: drop-shadow(0 2px 6px rgba(0,0,0,0.6));
  }

  .fast-badge {
    position: absolute;
    top: 12px;
    right: 12px;
    background: rgba(255,255,255,0.18);
    color: #fff;
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.05em;
    padding: 3px 10px;
    border-radius: 999px;
    pointer-events: none;
    z-index: 20;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    text-shadow: 0 1px 4px rgba(0,0,0,0.5);
  }

  .mute-badge {
    position: absolute;
    bottom: 80px;
    right: 14px;
    background: rgba(0,0,0,0.62);
    border-radius: 999px;
    padding: 8px 14px 8px 10px;
    z-index: 20;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid rgba(255,255,255,0.15);
    transition: opacity 0.15s ease;
    touch-action: none;
  }
  .mute-badge:active { opacity: 0.7; }
  .mute-label {
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    letter-spacing: 0.02em;
    text-shadow: 0 1px 3px rgba(0,0,0,0.6);
  }

  .scroll-hint {
    position: absolute;
    bottom: 180px;
    right: 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    color: rgba(255, 255, 255, 0.5);
    font-size: 11px;
    z-index: 10;
    pointer-events: none;
    transition: opacity 0.5s ease;
    animation: bounce 2s ease-in-out infinite;
  }
  .scroll-hint--hidden {
    opacity: 0;
    animation: none;
  }
  .scroll-arrow {
    font-size: 18px;
  }
  @keyframes bounce {
    0%, 100% { transform: translateY(0); }
    50%       { transform: translateY(6px); }
  }

  .skip-ripple {
    position: absolute;
    transform: translate(-50%, -50%);
    z-index: 20;
    pointer-events: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 90px;
    height: 90px;
    border-radius: 50%;
    background: rgba(255,255,255,0.2);
    backdrop-filter: blur(6px);
    animation: ripple-pop 0.65s ease-out forwards;
  }
  .skip-icon {
    color: #fff;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-shadow: 0 1px 4px rgba(0,0,0,0.6);
    white-space: nowrap;
  }
  @keyframes ripple-pop {
    0%   { opacity: 1; transform: translate(-50%, -50%) scale(0.6); }
    40%  { opacity: 1; transform: translate(-50%, -50%) scale(1.1); }
    100% { opacity: 0; transform: translate(-50%, -50%) scale(1.35); }
  }

  @media (prefers-reduced-motion: reduce) {
    .shimmer-inner  { animation: none; }
    .scroll-hint    { animation: none; }
    .skip-ripple    { animation: none; opacity: 0; }
    .action-overlay { animation: none; opacity: 0; }
  }
`;
