"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import type { MovieCard } from "@/lib/api/feed";

interface Props {
  item: MovieCard;
  isFirst: boolean;
}

const H_PADDING = 12; // 左右余白 px
const V_PADDING = 12; // 上下余白 px

export default function FeedItem({ item, isFirst }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);

  const [videoReady, setVideoReady] = useState(false);
  const [objectFit, setObjectFit] = useState<"cover" | "contain">("cover");

  // 動画のスタイル初期値: 全画面を占める fallback
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
    const overlay = overlayRef.current;
    const section = sectionRef.current;
    if (!overlay || !section) return;

    const overlayH = overlay.offsetHeight;
    const sectionH = section.offsetHeight; // = 100dvh 実値
    const sectionW = section.offsetWidth;

    const top = V_PADDING;
    const bottom = overlayH + V_PADDING;
    const safeH = sectionH - top - bottom;
    const safeW = sectionW - H_PADDING * 2;

    setVideoStyle({
      position: "absolute",
      top: `${top}px`,
      left: `${H_PADDING}px`,
      width: `${safeW}px`,
      height: `${safeH}px`,
      objectFit: fit,
      objectPosition: "center center",
      borderRadius: "12px",
      opacity: videoReady ? 1 : 0,
      transition: "opacity 0.3s ease",
    });
  // videoReady は別途 opacity のみ更新するので依存配列から除外
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectFit]);

  // opacity だけ別途更新（calcVideoArea を再実行しない）
  useEffect(() => {
    setVideoStyle((prev) => ({
      ...prev,
      opacity: videoReady ? 1 : 0,
    }));
  }, [videoReady]);

  // objectFit 変化時に再計算
  useEffect(() => {
    calcVideoArea(objectFit);
  }, [objectFit, calcVideoArea]);

  // overlay 高さ変化を監視
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const ro = new ResizeObserver(() => calcVideoArea());
    ro.observe(overlay);
    // マウント直後に一度計算
    calcVideoArea();
    return () => ro.disconnect();
  }, [calcVideoArea]);

  // メタデータ: 動画 vs 画面の縦横比を比較
  const handleMetadata = () => {
    const video = videoRef.current;
    const section = sectionRef.current;
    if (!video || !section) return;
    const videoAspect = video.videoWidth / video.videoHeight;
    const screenAspect = section.offsetWidth / section.offsetHeight;
    const fit = videoAspect <= screenAspect ? "cover" : "contain";
    setObjectFit(fit);
    calcVideoArea(fit);
  };

  // IntersectionObserver
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
          <div className="thumbnail-overlay" />
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
          <div className="thumbnail-overlay" />
        </div>
      )}

      <div ref={overlayRef} className="info-overlay">
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
    border-radius: 12px;
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
