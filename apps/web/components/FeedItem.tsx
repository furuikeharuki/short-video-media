"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { MovieCard } from "@/lib/api/feed";

export function FeedItem({ item, index }: { item: MovieCard; index: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          video.play().catch(() => {});
        } else {
          video.pause();
          video.currentTime = 0;
        }
      },
      { threshold: 0.6 }
    );

    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="feed-item">
      {item.sample_video_url ? (
        <div className="media-bg">
          <video
            ref={videoRef}
            className="media-player"
            src={item.sample_video_url}
            poster={item.thumbnail_url}
            muted
            loop
            playsInline
            preload={index === 0 ? "auto" : "none"}
          />
          <div className="media-overlay" />
        </div>
      ) : (
        <div className="media-bg">
          <img
            src={item.thumbnail_url}
            alt={item.title}
            className="media-player"
            loading={index === 0 ? "eager" : "lazy"}
            width={720}
            height={1280}
          />
          <div className="media-overlay" />
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
          <p className="item-actress">{item.actresses.join(" / ")}</p>
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

      {index === 0 && (
        <div className="scroll-hint">
          <span>スワイプ</span>
          <span className="scroll-arrow">↓</span>
        </div>
      )}
    </section>
  );
}
