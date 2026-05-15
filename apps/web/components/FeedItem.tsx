"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import type { MovieCard } from "@/lib/api/feed";
import ModalLoading from "@/app/@modal/(.)movies/[slug]/loading";

interface Props {
  item: MovieCard;
  isFirst: boolean;
  isSecond?: boolean;
  activeGenres?: string[];
  onGenreClick?: (genre: string) => void;
}

const SKIP_SEC = 5;
const DBL_TAP_MS = 300;
const LONG_PRESS_MS = 500;
const TAP_MOVE_THRESHOLD = 10;
const PLAY_THRESHOLD = 0.85;
const LOADING_DELAY_MS = 150;

let globalUserGestured = false;

export default function FeedItem({ item, isFirst, isSecond = false }: Props) {
  const router = useRouter();

  const videoRef      = useRef<HTMLVideoElement>(null);
  const sectionRef    = useRef<HTMLElement>(null);
  const containerRef  = useRef<HTMLDivElement>(null);
  const shimmerRef    = useRef<HTMLDivElement>(null);
  const fastBadgeRef  = useRef<HTMLDivElement>(null);
  const overlayRef    = useRef<HTMLDivElement>(null);
  const rafRef        = useRef<number | null>(null);
  const isActiveRef   = useRef(false);

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
  const loadingTimerRef          = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigatingRef            = useRef(false);

  const [isMuted,      setIsMuted]      = useState(true);
  const [isBookmarked, setIsBookmarked] = useState(false);
  const [navigating,   setNavigating]   = useState(false);
  const [mounted,      setMounted]      = useState(false);

  useEffect(() => { setMounted(true); }, []);

  // data-next-loading のない dialog（= 本物のMovieModal）が出たら仮モーダルを消す
  useEffect(() => {
    if (!navigating) return;
    const observer = new MutationObserver(() => {
      const realDialog = document.querySelector("[role='dialog']:not([data-next-loading])");
      if (realDialog) {
        setNavigating(false);
        navigatingRef.current = false;
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [navigating]);

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
    const handler = (e: CustomEvent<{ ratio: number }>) => {
      const video = videoRef.current;
      if (!video || !isActiveRef.current) return;
      const target = e.detail.ratio * (video.duration || 0);
      video.currentTime = target;
    };
    window.addEventListener("video-seek", handler);
    return () => window.removeEventListener("video-seek", handler);
  }, []);

  const playVideo = useCallback(async (video: HTMLVideoElement, withGesture = false) => {
    if (withGesture) globalUserGestured = true;
    video.muted = isMutedRef.current;
    if (globalUserGestured) {
      try {
        await video.play();
        isPlayingRef.current = true;
        startProgressLoop();
        return;
      } catch { /* fall through to muted retry */ }
    }
    video.muted = true;
    isMutedRef.current = true;
    setIsMuted(true);
    try {
      await video.play();
      isPlayingRef.current = true;
      startProgressLoop();
    } catch { /* ignore */ }
  }, [startProgressLoop]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const playObserver = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        isActiveRef.current = true;
        playVideo(video, false);
      } else {
        isActiveRef.current = false;
        stopProgressLoop();
        video.pause();
        video.currentTime = 0;
        video.playbackRate = 1;
        video.muted = true;
        isPlayingRef.current = false;
        isMutedRef.current   = true;
        setIsMuted(true);
        setVideoReady(false);
        setFastBadge(false);
        window.dispatchEvent(new CustomEvent("video-progress", { detail: { progress: 0 } }));
      }
    }, { threshold: PLAY_THRESHOLD });
    playObserver.observe(video);
    return () => {
      playObserver.disconnect();
      stopProgressLoop();
    };
  }, [playVideo, setVideoReady, setFastBadge, stopProgressLoop]);

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
      video.muted = false;
      isMutedRef.current = false;
      setIsMuted(false);
      if (video.paused) { video.play().catch(() => {}); isPlayingRef.current = true; startProgressLoop(); }
    } else {
      video.muted = true;
      isMutedRef.current = true;
      setIsMuted(true);
    }
  }, [startProgressLoop]);

  const handleShare = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const url = `${window.location.origin}/?v=${item.slug}`;
    if (navigator.share) {
      navigator.share({ title: item.title, url }).catch(() => {});
    } else {
      navigator.clipboard.writeText(url).catch(() => {});
    }
  }, [item.slug, item.title]);

  const handleDetail = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    e.preventDefault();

    navigatingRef.current = true;
    router.push(`/movies/${item.slug}`);

    if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
    loadingTimerRef.current = setTimeout(() => {
      if (navigatingRef.current) setNavigating(true);
    }, LOADING_DELAY_MS);
  }, [router, item.slug]);

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

  const preloadAttr = isFirst || isSecond ? "auto" : "metadata";

  return (
    <>
      {mounted && navigating && createPortal(<ModalLoading />, document.body)}
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

            <video
              ref={videoRef}
              src={item.sample_movie_url}
              muted
              loop
              playsInline
              preload={preloadAttr}
              onLoadedData={() => setVideoReady(true)}
              onCanPlay={() => setVideoReady(true)}
              className="feed-video"
              style={{ opacity: 0, transition: "opacity 0.3s ease" }}
            />

            <div className="overlay-wrap">
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
            </div>

            <div ref={fastBadgeRef} className="fast-badge" aria-hidden="true" style={{ display: "none" }}>2×</div>
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

        <div className="bottom-bar">
          <div className="info-overlay" onClick={(e) => e.stopPropagation()}>
            {item.genres && item.genres.length > 0 && (
              <div className="genre-chips" onClick={(e) => e.stopPropagation()}>
                {item.genres.map((tag) => (
                  <button
                    key={tag}
                    className="genre-chip"
                    onClick={() => router.push(`/search?genre=${encodeURIComponent(tag)}`)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
            <h2 className="item-title">{item.title}</h2>
            {item.actresses.length > 0 && (
              <p className="item-actress">👤 {item.actresses.join(" / ")}</p>
            )}
          </div>

          <div className="side-actions" onClick={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}>
            <button
              className="side-btn"
              aria-label={isMuted ? "音声ON" : "ミュート"}
              onTouchEnd={handleToggleMute}
              onClick={handleToggleMute}
            >
              {isMuted ? (
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                  <path d="M11 5L6 9H2v6h4l5 4V5z" fill="white"/>
                  <line x1="23" y1="9" x2="17" y2="15" stroke="white" strokeWidth="2.2" strokeLinecap="round"/>
                  <line x1="17" y1="9" x2="23" y2="15" stroke="white" strokeWidth="2.2" strokeLinecap="round"/>
                </svg>
              ) : (
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                  <path d="M11 5L6 9H2v6h4l5 4V5z" fill="white"/>
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" stroke="white" strokeWidth="2" strokeLinecap="round"/>
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" stroke="white" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              )}
              <span className="side-btn-label">{isMuted ? "音声OFF" : "音声ON"}</span>
            </button>

            <button
              className={`side-btn${isBookmarked ? " side-btn--active" : ""}`}
              aria-label="ブックマーク"
              onTouchEnd={(e) => { e.stopPropagation(); e.preventDefault(); setIsBookmarked(b => !b); }}
              onClick={(e) => { e.stopPropagation(); setIsBookmarked(b => !b); }}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill={isBookmarked ? "white" : "none"} stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
              </svg>
              <span className="side-btn-label">保存</span>
            </button>

            <button
              className="side-btn"
              aria-label="共有"
              onTouchEnd={handleShare}
              onClick={handleShare}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3"/>
                <circle cx="6" cy="12" r="3"/>
                <circle cx="18" cy="19" r="3"/>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
              </svg>
              <span className="side-btn-label">共有</span>
            </button>

            <button
              className="side-btn"
              aria-label="詳細を見る"
              onTouchEnd={handleDetail}
              onClick={handleDetail}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span className="side-btn-label">詳細</span>
            </button>

            <a
              href={item.affiliate_url}
              target="_blank"
              rel="noopener noreferrer"
              className="side-btn side-btn--buy"
              aria-label="購入する"
              onClick={(e) => e.stopPropagation()}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9" cy="21" r="1"/>
                <circle cx="20" cy="21" r="1"/>
                <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
              </svg>
              <span className="side-btn-label">購入</span>
            </a>
          </div>
        </div>

        <style>{itemStyle}</style>
      </section>
    </>
  );
}

const itemStyle = `
  .video-bg {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: #000;
  }
  .feed-video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    object-position: center center;
    border-radius: 8px;
    box-sizing: border-box;
  }
  .overlay-wrap {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 25;
    border-radius: 8px;
    overflow: hidden;
  }
  .shimmer {
    position: absolute;
    inset: 0;
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
    touch-action: none;
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
  .bottom-bar {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: end;
    z-index: 30;
    padding: 0 4px 15px 12px;
    box-sizing: border-box;
    pointer-events: none;
    background: linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 100%);
  }
  .info-overlay {
    min-width: 0;
    overflow: hidden;
    pointer-events: auto;
    padding-right: 0;
  }
  .item-title {
    font-size: clamp(13px, 3.5vw, 16px);
    font-weight: 700;
    line-height: 1.35;
    color: #fff;
    text-shadow: 0 1px 6px rgba(0,0,0,0.8);
    margin: 0 0 4px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-all;
  }
  .item-actress {
    font-size: clamp(11px, 2.8vw, 13px);
    color: rgba(255,255,255,0.75);
    text-shadow: 0 1px 4px rgba(0,0,0,0.7);
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .genre-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 6px;
  }
  .genre-chip {
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid rgba(255,255,255,0.35);
    background: rgba(255,255,255,0.12);
    color: rgba(255,255,255,0.9);
    font-size: clamp(10px, 2.5vw, 12px);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    -webkit-tap-highlight-color: transparent;
    line-height: 1.5;
    transition: background 0.15s;
  }
  .genre-chip:active { background: rgba(255,255,255,0.25); }
  .side-actions {
    width: 53px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: clamp(14px, 2.2vh, 24px);
    pointer-events: auto;
    flex-shrink: 0;
  }
  .side-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    width: 100%;
    -webkit-tap-highlight-color: transparent;
    touch-action: none;
    text-decoration: none;
    filter: drop-shadow(0 1px 4px rgba(0,0,0,0.8));
    transition: transform 0.1s ease, opacity 0.1s ease;
  }
  .side-btn:active { transform: scale(0.88); opacity: 0.7; }
  .side-btn--active svg { filter: drop-shadow(0 0 6px rgba(255,255,255,0.8)); }
  .side-btn--buy svg { stroke: #ff4d7d; }
  .side-btn-label {
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-shadow: 0 1px 3px rgba(0,0,0,0.9);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
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
    .skip-ripple    { animation: none; opacity: 0; }
    .action-overlay { animation: none; opacity: 0; }
  }
  @media (max-width: 767px) {
    .feed-video {
      padding-bottom: 60px;
    }
    .overlay-wrap {
      bottom: 60px;
    }
  }
  @media (min-width: 768px) {
    .bottom-bar {
      padding: 0 8px 20px 20px;
    }
    .side-actions {
      width: 60px;
      gap: 20px;
    }
    .side-btn svg { width: 28px; height: 28px; }
    .item-title   { font-size: 17px; }
    .item-actress { font-size: 14px; }
  }
`;
