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

const isLandscapeScreen = () => window.innerWidth > window.innerHeight;

type Ripple = { id: number; x: number; y: number; dir: "left" | "right" };

export default function FeedItem({ item, isFirst }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapCountRef = useRef(0);

  const [videoReady, setVideoReady] = useState(false);
  const [objectFit, setObjectFit] = useState<"cover" | "contain">("cover");
  const [ripples, setRipples] = useState<Ripple[]>([]);

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

  const calcVideoArea = useCallback((fit: "cover" | "contain" = objectFit) => {
    const cta = ctaRef.current;
    const section = sectionRef.current;
    if (!cta || !section) return;
    const sectionRect = section.getBoundingClientRect();
    const ctaRect = cta.getBoundingClientRect();
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

  // ハッシュ復元
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

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
        } else {
          video.pause(); video.currentTime = 0; setVideoReady(false);
        }
      },
      { threshold: 0.7 }
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  const handleDetailClick = () => {
    history.replaceState(null, "", `#${item.slug}`);
  };

  const fireTap = useCallback((clientX: number, clientY: number) => {
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
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    setRipples((prev) => [...prev, { id, x, y, dir }]);
    setTimeout(() => setRipples((prev) => prev.filter((r) => r.id !== id)), 700);
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!videoRef.current) return;
    const touch = e.changedTouches[0];
    const { clientX, clientY } = touch;
    tapCountRef.current += 1;
    if (tapCountRef.current === 1) {
      tapTimerRef.current = setTimeout(() => { tapCountRef.current = 0; }, DBL_TAP_MS);
    } else if (tapCountRef.current >= 2) {
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
      tapCountRef.current = 0;
      fireTap(clientX, clientY);
    }
  }, [fireTap]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    fireTap(e.clientX, e.clientY);
  }, [fireTap]);

  return (
    <section ref={sectionRef} className="feed-item">
      {item.sample_video_url ? (
        <div
          className="video-bg video-bg--interactive"
          onTouchEnd={handleTouchEnd}
          onDoubleClick={handleDoubleClick}
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
      rgba(255, 255, 255, 0.06) 50%,
      transparent 60%
    );
    background-size: 200% 100%;
    animation: shimmer-slide 1.4s ease-in-out infinite;
  }
  @keyframes shimmer-slide {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  /* ダブルタップ操作用ラップー: レイアウトに影響させないよう CSS クラスで管理 */
  .video-bg--interactive {
    cursor: pointer;
    /* タッチ時の青ハイライトを消去 */
    -webkit-tap-highlight-color: transparent;
    tap-highlight-color: transparent;
    /* 長押し時のコンテキストメニューを無効化 */
    -webkit-touch-callout: none;
    user-select: none;
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
    .shimmer-inner { animation: none; }
    .scroll-hint   { animation: none; }
    .skip-ripple   { animation: none; opacity: 0; }
  }
`;
