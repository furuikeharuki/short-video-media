"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import type { MovieCard } from "@/lib/api/feed";

interface Props {
  item: MovieCard;
  isFirst: boolean;
}

const H_PADDING = 4;
const V_PADDING = 4;

const isLandscapeScreen = () => window.innerWidth > window.innerHeight;

export default function FeedItem({ item, isFirst }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);

  const [videoReady, setVideoReady] = useState(false);
  const [objectFit, setObjectFit] = useState<"cover" | "contain">("cover");

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

    // section 内での CTA の top 相対座標
    const ctaTopInSection = ctaRect.top - sectionRect.top;

    const top = V_PADDING;
    // 動画の下辺 = CTA の上辺 - gap
    const height = ctaTopInSection - top - V_PADDING;
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

  useEffect(() => {
    calcVideoArea(objectFit);
  }, [objectFit, calcVideoArea]);

  useEffect(() => {
    const cta = ctaRef.current;
    if (!cta) return;
    const ro = new ResizeObserver(() => calcVideoArea());
    ro.observe(cta);
    calcVideoArea();
    return () => ro.disconnect();
  }, [calcVideoArea]);

  const handleMetadata = () => {
    const video = videoRef.current;
    const section = sectionRef.current;
    if (!video || !section) return;

    if (isLandscapeScreen()) {
      setObjectFit("contain");
      calcVideoArea("contain");
      return;
    }

    const videoAspect = video.videoWidth / video.videoHeight;
    const screenAspect = section.offsetWidth / section.offsetHeight;
    const fit = videoAspect <= screenAspect ? "cover" : "contain";
    setObjectFit(fit);
    calcVideoArea(fit);
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          video.play().catch(() => {
            video.muted = true;
            video.play().catch(() => {});
          });
        } else {
          video.pause();
          video.currentTime = 0;
          setVideoReady(false);
        }
      },
      { threshold: 0.7 }
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={sectionRef} className="feed-item">
      {item.sample_video_url ? (
        <div className="video-bg">
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
          <Link href={`/movies/${item.slug}`} className="btn-detail">
            詳細を見る
          </Link>
          <a
            href={item.affiliate_url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-buy"
          >
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
    top: ${V_PADDING}px;
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
  @media (prefers-reduced-motion: reduce) {
    .shimmer-inner { animation: none; }
    .scroll-hint   { animation: none; }
  }
`;
