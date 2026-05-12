"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { MovieCard } from "@/lib/api/feed";

interface Props {
  item: MovieCard;
  isFirst: boolean;
}

// 動画を配置する安全領域の上下パディング
const VERTICAL_PADDING = 16; // px

export default function FeedItem({ item, isFirst }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [objectFit, setObjectFit] = useState<"cover" | "contain">("cover");
  // 動画エリアの上下位置（下部オーバーレイ分を除いた中央）
  const [videoStyle, setVideoStyle] = useState<React.CSSProperties>({});

  // 下部オーバーレイの高さを計測して動画配置領域を計算
  const calcVideoArea = () => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const overlayHeight = overlay.offsetHeight;
    const screenH = window.innerHeight;
    const screenW = window.innerWidth;

    // 安全領域: 上下 VERTICAL_PADDING + 下部オーバーレイ分を除いた高さ
    const safeTop = VERTICAL_PADDING;
    const safeBottom = overlayHeight + VERTICAL_PADDING;
    const safeHeight = screenH - safeTop - safeBottom;

    setVideoStyle({
      position: "absolute",
      left: `${VERTICAL_PADDING}px`,
      right: `${VERTICAL_PADDING}px`,
      top: `${safeTop}px`,
      height: `${safeHeight}px`,
      width: `calc(100% - ${VERTICAL_PADDING * 2}px)`,
      objectFit,
      objectPosition: "center center",
      borderRadius: "12px",
      opacity: videoReady ? 1 : 0,
      transition: "opacity 0.3s ease",
    });
  };

  // メタデータロード時に動画 vs 画面の縦横比を比較
  const handleMetadata = () => {
    const video = videoRef.current;
    if (!video) return;

    const videoAspect = video.videoWidth / video.videoHeight;
    const screenAspect = window.innerWidth / window.innerHeight;
    const fit = videoAspect <= screenAspect ? "cover" : "contain";
    setObjectFit(fit);
  };

  // objectFit または overlay 高さが変わったら videoStyle を再計算
  useEffect(() => {
    calcVideoArea();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectFit]);

  // ResizeObserver で overlay 高さ変化を監視
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const ro = new ResizeObserver(() => calcVideoArea());
    ro.observe(overlay);
    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectFit]);

  // IntersectionObserver: 画面内に入ったら再生・出たら停止
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
    <section className="feed-item">
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
            onCanPlay={() => {
              setVideoReady(true);
              calcVideoArea();
            }}
            style={videoStyle}
          />
          {/* contain時の黒帯部分にボカシ投影効果 */}
          {objectFit === "contain" && (
            <div className="video-blur-bg" aria-hidden="true" />
          )}
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

      {/* 下部オーバーレイ */}
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
    inset: 0;
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
  /* contain時の背景: サムネイルをゼロでblur */
  .video-blur-bg {
    position: absolute;
    inset: 0;
    background: #0d0d0d;
    z-index: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .shimmer-inner { animation: none; }
    .scroll-hint   { animation: none; }
  }
`;
