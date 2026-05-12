"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { MovieCard } from "@/lib/api/feed";

interface Props {
  item: MovieCard;
  isFirst: boolean;
}

export default function FeedItem({ item, isFirst }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoReady, setVideoReady] = useState(false);

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
          // 画面外に出たらローディング状態にリセット
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
          {/* シマーローダー: 動画がcanplayになるまで表示 */}
          {!videoReady && (
            <div className="shimmer" aria-hidden="true">
              <div className="shimmer-inner" />
            </div>
          )}

          <video
            ref={videoRef}
            className="video-player"
            src={item.sample_video_url}
            muted
            loop
            playsInline
            preload={isFirst ? "auto" : "none"}
            onCanPlay={() => setVideoReady(true)}
            style={{ opacity: videoReady ? 1 : 0, transition: "opacity 0.3s ease" }}
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

      {/* 下部オーバーレイ */}
      <div className="info-overlay">
        <div className="genre-list">
          {item.genres.map((g) => (
            <span key={g} className="genre-badge">
              {g}
            </span>
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

      {/* スクロールヒント（最初の1枚のみ） */}
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
  /* ─── シマーローダー ─────────────────── */
  .shimmer {
    position: absolute;
    inset: 0;
    background: #1a1a1a;
    z-index: 1;
    overflow: hidden;
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
