"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import type { MovieCard } from "@/lib/api/feed";

interface Props {
  item: MovieCard;
  isFirst: boolean;
  isSecond?: boolean;
}

const SKIP_SEC = 5;
const DBL_TAP_MS = 300;
const LONG_PRESS_MS = 500;
const TAP_MOVE_THRESHOLD = 10;
const PLAY_THRESHOLD = 0.5;
const PRELOAD_THRESHOLD = 0.1;

type Ripple = { id: number; x: number; y: number; dir: "left" | "right" };
type Overlay = "pause" | "play" | null;

let globalUserGestured = false;

export default function FeedItem({ item, isFirst, isSecond = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const preloadStartedRef = useRef(false);

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
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [overlay, setOverlay] = useState<Overlay>(null);

  const showOverlay = useCallback((type: Overlay) => {
    setOverlay(type);
    setTimeout(() => setOverlay(null), 700);
  }, []);

  // ハッシュスクロール復元
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

  const playVideo = useCallback(async (video: HTMLVideoElement, withGesture = false) => {
    if (withGesture) globalUserGestured = true;

    if (globalUserGestured) {
      video.muted = false;
      setIsMuted(false);
      try { await video.play(); setIsPlaying(true); return; } catch { /* fall through */ }
    }

    video.muted = true;
    setIsMuted(true);
    try { await video.play(); setIsPlaying(true); } catch { /* ignore */ }
  }, []);

  // IntersectionObserver: 先読み + 再生制御
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const preloadObserver = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !preloadStartedRef.current) {
          preloadStartedRef.current = true;
          if (video.preload === "none") { video.preload = "auto"; video.load(); }
        }
      },
      { threshold: PRELOAD_THRESHOLD }
    );

    const playObserver = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          playVideo(video, false);
        } else {
          video.pause();
          video.currentTime = 0;
          video.playbackRate = 1;
          video.muted = true;
          video.preload = isFirst || isSecond ? "auto" : "none";
          preloadStartedRef.current = isFirst || isSecond;
          setIsPlaying(false);
          setIsFast(false);
          setIsMuted(true);
          setVideoReady(false);
        }
      },
      { threshold: PLAY_THRESHOLD }
    );

    preloadObserver.observe(video);
    playObserver.observe(video);
    return () => { preloadObserver.disconnect(); playObserver.disconnect(); };
  }, [playVideo, isFirst, isSecond]);

  // contextmenu 抑制
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const prevent = (e: Event) => e.preventDefault();
    el.addEventListener("contextmenu", prevent);
    return () => el.removeEventListener("contextmenu", prevent);
  }, []);

  const handleDetailClick = () => history.replaceState(null, "", `#${item.slug}`);

  const fireSkip = useCallback((clientX: number, clientY: number) => {
    const video = videoRef.current;
    const section = sectionRef.current;
    if (!video || !section) return;
    const rect = section.getBoundingClientRect();
    const isLeft = clientX - rect.left < rect.width / 2;
    const dir = isLeft ? "left" : "right";
    video.currentTime = isLeft
      ? Math.max(0, video.currentTime - SKIP_SEC)
      : Math.min(video.duration || Infinity, video.currentTime + SKIP_SEC);
    const id = Date.now();
    setRipples((prev) => [...prev, { id, x: clientX - rect.left, y: clientY - rect.top, dir }]);
    setTimeout(() => setRipples((prev) => prev.filter((r) => r.id !== id)), 700);
  }, []);

  const fireTogglePlay = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) { await playVideo(video, true); showOverlay("play"); }
    else { video.pause(); setIsPlaying(false); showOverlay("pause"); }
  }, [playVideo, showOverlay]);

  const handleUnmute = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video) return;
    globalUserGestured = true;
    video.muted = false;
    setIsMuted(false);
    if (video.paused) { video.play().catch(() => {}); setIsPlaying(true); }
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
    const wasLong = isLongPressRef.current;
    if (wasLong && videoRef.current) {
      videoRef.current.playbackRate = 1;
      setIsFast(false);
      isLongPressRef.current = false;
    }
    return wasLong;
  }, []);

  // タッチイベント
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

  // マウスイベント（PC専用）
  const handleMouseDown = useCallback(() => {
    if (isTouchDeviceRef.current) return;
    startLongPress();
  }, [startLongPress]);

  const handleMouseUpWithFlag = useCallback(() => {
    if (isTouchDeviceRef.current) return;
    if (endLongPress()) wasLongPressJustEndedRef.current = true;
  }, [endLongPress]);

  const handleMouseLeaveWithFlag = useCallback(() => {
    if (isTouchDeviceRef.current) return;
    if (endLongPress()) wasLongPressJustEndedRef.current = true;
  }, [endLongPress]);

  const pcClickCountRef = useRef(0);
  const pcClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    <section ref={sectionRef} className="feed-item">
      {/* 動画エリア: flex-1 で残り全高を占有 */}
      <div className="feed-item__video-area">
        {item.sample_video_url ? (
          <div
            ref={containerRef}
            className="feed-item__video-container"
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchCancel}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUpWithFlag}
            onMouseLeave={handleMouseLeaveWithFlag}
            onClick={handlePcClick}
          >
            {/* shimmer: videoReady になるまで表示 */}
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
              preload={preloadAttr}
              onCanPlay={() => setVideoReady(true)}
              className="feed-item__video"
              style={{ opacity: videoReady ? 1 : 0 }}
            />

            {/* 一時停止/再生オーバーレイ */}
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

            {isFast && <div className="fast-badge" aria-hidden="true">2×</div>}

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
              <div key={r.id} className="skip-ripple" style={{ left: r.x, top: r.y }} aria-hidden="true">
                <span className="skip-icon">{r.dir === "left" ? "« -5s" : "+5s »"}</span>
              </div>
            ))}
          </div>
        ) : (
          <img
            src={item.thumbnail_url ?? ""}
            alt={item.title}
            className="feed-item__thumbnail"
            loading={isFirst ? "eager" : "lazy"}
            width={720}
            height={1280}
          />
        )}
      </div>

      {/* 情報エリア: 固定高さ、動画エリアの下に配置 */}
      <div className="feed-item__info">
        <div className="genre-list">
          {item.genres.map((g) => (
            <span key={g} className="genre-badge">{g}</span>
          ))}
        </div>
        <h2 className="item-title">{item.title}</h2>
        {item.actresses.length > 0 && (
          <p className="item-actress">👤 {item.actresses.join(" / ")}</p>
        )}
        <div className="cta-buttons">
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
    </section>
  );
}
