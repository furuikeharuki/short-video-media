"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import type { MovieCard } from "@/lib/api/feed";

interface Props {
  item: MovieCard;
  isFirst: boolean;
}

const H_PADDING = 4;
const V_PADDING_TOP = 4;
const V_PADDING_BOTTOM = 16;
const SKIP_SEC = 5;
const DBL_TAP_MS = 300;
const LONG_PRESS_MS = 500;
const TAP_MOVE_THRESHOLD = 10;

const isLandscapeScreen = () => window.innerWidth > window.innerHeight;

type Ripple = { id: number; x: number; y: number; dir: "left" | "right" };
type Overlay = "pause" | "play" | null;

let globalUserGestured = false;

export default function FeedItem({ item, isFirst }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapCountRef = useRef(0);
  const tapStartPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLongPressRef = useRef(false);
  const wasLongPressJustEndedRef = useRef(false);

  const isTouchDeviceRef = useRef(false);
  const lastTouchEndRef = useRef(0);

  const [videoReady, setVideoReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [isFast, setIsFast] = useState(false);
  const [objectFit, setObjectFit] = useState<"cover" | "contain">("cover");
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [overlay, setOverlay] = useState<Overlay>(null);

  const [videoStyle, setVideoStyle] = useState<React.CSSProperties>({
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
    objectPosition: "center center",
    opacity: 0,
    transition: "opacity 0.3s ease",
  });

  const showOverlay = useCallback((type: Overlay) => {
    setOverlay(type);
    setTimeout(() => setOverlay(null), 700);
  }, []);

  const calcVideoArea = useCallback((fit: "cover" | "contain" = objectFit) => {
    const cta = ctaRef.current;
    const section = sectionRef.current;
    if (!cta || !section) return;
    const sectionRect = section.getBoundingClientRect();
    const ctaRect = cta.getBoundingClientRect();
    if (ctaRect.top === 0 && ctaRect.height === 0) {
      requestAnimationFrame(() => calcVideoArea(fit));
      return;
    }
    const ctaTopInSection = ctaRect.top - sectionRect.top;
    const top = V_PADDING_TOP;
    const height = ctaTopInSection - top - V_PADDING_BOTTOM;
    const width = section.offsetWidth - H_PADDING * 2;
    setVideoStyle({
      position: "absolute",
      top: `${top}px`,
      left: `${H_PADDING}px`,
      width: `${width}px`,
      height: `${Math.max(height, 0)}px`,
      objectFit: fit,
      objectPosition: "center center",
      borderRadius: "8px",
      opacity: videoReady ? 1 : 0,
      transition: "opacity 0.3s ease",
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectFit]);

  useEffect(() => {
    setVideoStyle((prev) => ({ ...prev, opacity: videoReady ? 1 : 0 }));
  }, [videoReady]);

  useEffect(() => { calcVideoArea(objectFit); }, [objectFit, calcVideoArea]);

  useEffect(() => {
    const cta = ctaRef.current;
    if (!cta) return;
    const ro = new ResizeObserver(() => calcVideoArea());
    ro.observe(cta);
    calcVideoArea();
    return () => ro.disconnect();
  }, [calcVideoArea]);

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash !== item.slug) return;
    const section = sectionRef.current;
    if (!section) return;
    requestAnimationFrame(() => {
      section.scrollIntoView({ behavior: "instant", block: "start" });
      history.replaceState(null, "", window.location.pathname);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMetadata = () => {
    const video = videoRef.current;
    const section = sectionRef.current;
    if (!video || !section) return;
    if (isLandscapeScreen()) {
      setObjectFit("contain"); calcVideoArea("contain"); return;
    }
    const videoAspect = video.videoWidth / video.videoHeight;
    const screenAspect = section.offsetWidth / section.offsetHeight;
    const fit = videoAspect <= screenAspect ? "cover" : "contain";
    setObjectFit(fit); calcVideoArea(fit);
  };

  const playVideo = useCallback(async (video: HTMLVideoElement, withGesture = false) => {
    if (withGesture) globalUserGestured = true;

    if (globalUserGestured) {
      video.muted = false;
      setIsMuted(false);
      try {
        await video.play();
        setIsPlaying(true);
        return;
      } catch {
        // fall through to muted retry
      }
    }

    video.muted = true;
    setIsMuted(true);
    try {
      await video.play();
      setIsPlaying(true);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          playVideo(video, false);
        } else {
          video.pause();
          video.currentTime = 0;
          video.playbackRate = 1;
          video.muted = true;
          setIsPlaying(false);
          setIsFast(false);
          setIsMuted(true);
          setVideoReady(false);
        }
      },
      { threshold: 0.7 }
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [playVideo]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const prevent = (e: Event) => e.preventDefault();
    el.addEventListener("contextmenu", prevent);
    return () => el.removeEventListener("contextmenu", prevent);
  }, []);

  const handleDetailClick = () => {
    history.replaceState(null, "", `#${item.slug}`);
  };

  const fireSkip = useCallback((clientX: number, clientY: number) => {
    const video = videoRef.current;
    const section = sectionRef.current;
    if (!video || !section) return;
    const rect = section.getBoundingClientRect();
    const isLeft = clientX - rect.left < rect.width / 2;
    const dir = isLeft ? "left" : "right";
    if (isLeft) {
      video.currentTime = Math.max(0, video.currentTime - SKIP_SEC);
    } else {
      video.currentTime = Math.min(video.duration || Infinity, video.currentTime + SKIP_SEC);
    }
    const id = Date.now();
    setRipples((prev) => [...prev, { id, x: clientX - rect.left, y: clientY - rect.top, dir }]);
    setTimeout(() => setRipples((prev) => prev.filter((r) => r.id !== id)), 700);
  }, []);

  const fireTogglePlay = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      await playVideo(video, true);
      showOverlay("play");
    } else {
      video.pause();
      setIsPlaying(false);
      showOverlay("pause");
    }
  }, [playVideo, showOverlay]);

  /** ミュートバッジ押下：伝播を止めてunmuteのみ行う */
  const handleUnmute = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video) return;
    globalUserGestured = true;
    video.muted = false;
    setIsMuted(false);
    // 停止中なら再生も開始
    if (video.paused) {
      video.play().catch(() => {});
      setIsPlaying(true);
    }
  }, []);

  const startLongPress = useCallback(() => {
    isLongPressRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      const video = videoRef.current;
      if (!video) return;
      isLongPressRef.current = true;
      video.playbackRate = 2;
      setIsFast(true);
    }, LONG_PRESS_MS);
  }, []);

  const endLongPress = useCallback((): boolean => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    const video = videoRef.current;
    const wasLong = isLongPressRef.current;
    if (wasLong && video) {
      video.playbackRate = 1;
      setIsFast(false);
      isLongPressRef.current = false;
    }
    return wasLong;
  }, []);

  // ─── タッチイベント ──────────────────────────────────────────────
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

  // ─── マウスイベント（PC専用）────────────────────────────────────
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

  const pcClickCountRef = useRef(0);
  const pcClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePcClick = useCallback((e: React.MouseEvent) => {
    if (isTouchDeviceRef.current) return;
    if (Date.now() - lastTouchEndRef.current < 500) return;
    if (wasLongPressJustEndedRef.current) {
      wasLongPressJustEndedRef.current = false;
      return;
    }
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

  return (
    <section ref={sectionRef} className="feed-item">
      {item.sample_video_url ? (
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
          {!videoReady && (
            <div className="shimmer" aria-hidden="true">
              <div className="shimmer-inner" />
            </div>
          )}
          <video
            ref={videoRef}
            src={item.sample_video_url}
            muted
            loop
            playsInline
            preload={isFirst ? "auto" : "none"}
            onLoadedMetadata={handleMetadata}
            onCanPlay={() => setVideoReady(true)}
            style={videoStyle}
          />

          {overlay && (
            <div className="action-overlay" aria-hidden="true">
              <span className="action-icon">
                {overlay === "pause" && (
                  <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                    <rect x="12" y="8" width="10" height="32" rx="2" fill="white"/>
                    <rect x="26" y="8" width="10" height="32" rx="2" fill="white"/>
                  </svg>
                )}
                {overlay === "play" && (
                  <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                    <path d="M14 8L40 24L14 40V8Z" fill="white"/>
                  </svg>
                )}
              </span>
            </div>
          )}

          {videoReady && !isPlaying && (
            <div className="pause-badge" aria-hidden="true">
              <svg width="40" height="40" viewBox="0 0 48 48" fill="none">
                <rect x="12" y="8" width="10" height="32" rx="2" fill="white"/>
                <rect x="26" y="8" width="10" height="32" rx="2" fill="white"/>
              </svg>
            </div>
          )}

          {isFast && (
            <div className="fast-badge" aria-hidden="true">2×</div>
          )}

          {/* ミュートバッジ：stopPropagation で親への伝播を遮断 */}
          {isMuted && isPlaying && (
            <div
              className="mute-badge"
              aria-label="タップしてミュート解除"
              role="button"
              onClick={handleUnmute}
              onTouchEnd={handleUnmute}
            >
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                <path d="M11 5L6 9H2v6h4l5 4V5z" fill="white"/>
                <line x1="23" y1="9" x2="17" y2="15" stroke="white" strokeWidth="2.2" strokeLinecap="round"/>
                <line x1="17" y1="9" x2="23" y2="15" stroke="white" strokeWidth="2.2" strokeLinecap="round"/>
              </svg>
              <span className="mute-label">タップで音声ON</span>
            </div>
          )}

          {ripples.map((r) => (
            <div
              key={r.id}
              className="skip-ripple"
              style={{ left: r.x, top: r.y }}
              aria-hidden="true"
            >
              <span className="skip-icon">
                {r.dir === "left" ? "« -5s" : "+5s »"}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="thumbnail-bg">
          <img
            src={item.thumbnail_url ?? ""}
            alt={item.title}
            className="thumbnail-img"
            loading={isFirst ? "eager" : "lazy"}
            width={720}
            height={1280}
          />
        </div>
      )}

      <div className="info-overlay">
        <div className="genre-list">
          {item.genres.map((g) => (
            <span key={g} className="genre-badge">{g}</span>
          ))}
        </div>
        <h2 className="item-title">{item.title}</h2>
        {item.actresses.length > 0 && (
          <p className="item-actress">👤 {item.actresses.join(" / ")}</p>
        )}
        <div ref={ctaRef} className="cta-buttons">
          <Link href={`/movies/${item.slug}`} className="btn-detail" onClick={handleDetailClick}>
            詳細を見る
          </Link>
          <a href={item.affiliate_url} target="_blank" rel="noopener noreferrer" className="btn-buy">
            購入する →
          </a>
        </div>
      </div>

      {isFirst && (
        <div className="scroll-hint">
          <span>スワイプ</span>
          <span className="scroll-arrow">↓</span>
        </div>
      )}

      <style>{itemStyle}</style>
    </section>
  );
}

const itemStyle = `
  .shimmer {
    position: absolute;
    top: ${V_PADDING_TOP}px;
    left: ${H_PADDING}px;
    right: ${H_PADDING}px;
    bottom: 0;
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

  .action-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 25;
    pointer-events: none;
    animation: overlay-pop 0.65s ease-out forwards;
  }
  .action-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    filter: drop-shadow(0 2px 8px rgba(0,0,0,0.7));
  }
  @keyframes overlay-pop {
    0%   { opacity: 1; transform: scale(0.7); }
    30%  { opacity: 1; transform: scale(1.1); }
    70%  { opacity: 0.8; transform: scale(1); }
    100% { opacity: 0; transform: scale(1); }
  }

  .pause-badge {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    opacity: 0.7;
    pointer-events: none;
    z-index: 20;
    filter: drop-shadow(0 2px 6px rgba(0,0,0,0.6));
    display: flex;
    align-items: center;
    justify-content: center;
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
