"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import FeedItem from "@/components/FeedItem";
import type { MovieCard } from "@/lib/api/feed";

const STORAGE_KEY = "search_feed_items";

export default function SearchFeedPage() {
  const searchParams = useSearchParams();
  const start = Number(searchParams.get("start") ?? "0");

  const items = useMemo<MovieCard[]>(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr: MovieCard[] = JSON.parse(raw);
      return [...arr.slice(start), ...arr.slice(0, start)];
    } catch {
      return [];
    }
  }, [start]);

  if (items.length === 0) {
    return (
      <div style={styles.empty}>
        該当する作品が見つかりませんでした
      </div>
    );
  }

  return (
    <>
      <main className="feed-container">
        {items.map((item, index) => (
          <FeedItem
            key={item.id}
            item={item}
            isFirst={index === 0}
            isSecond={index === 1}
          />
        ))}
      </main>
      <style>{feedStyle}</style>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  empty: {
    position: "fixed" as const,
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#000",
    color: "rgba(255,255,255,0.4)",
    fontSize: "14px",
  },
};

const feedStyle = `
  html { background: #000; }
  body { background: #000; overflow: hidden; height: 100dvh; }
  .feed-container {
    position: fixed;
    top: var(--header-h);
    left: 0; right: 0; bottom: 0;
    overflow-y: scroll;
    scroll-snap-type: y mandatory;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-y: contain;
    scrollbar-width: none;
  }
  .feed-container::-webkit-scrollbar { display: none; }
  .feed-item {
    position: relative;
    width: 100%;
    height: calc(100dvh - var(--header-h));
    scroll-snap-align: start;
    scroll-snap-stop: always;
    overflow: hidden;
    background: #000;
  }
  .video-bg { position: absolute; inset: 0; }
  .video-player { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumbnail-bg { position: absolute; inset: 0; }
  .thumbnail-img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumbnail-overlay { display: none; }
  .info-overlay {
    position: absolute;
    bottom: 0; left: 0; right: 0;
    padding: 0 16px 32px;
    color: #fff;
    z-index: 10;
  }
  .genre-list { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .genre-badge {
    display: inline-block;
    background: rgba(255,255,255,0.15);
    border: 1px solid rgba(255,255,255,0.3);
    backdrop-filter: blur(4px);
    color: #fff; font-size: 11px; font-weight: 600;
    letter-spacing: 0.05em; padding: 3px 10px; border-radius: 999px;
  }
  .item-title {
    font-size: clamp(16px, 4vw, 22px); font-weight: 700; line-height: 1.3;
    margin-bottom: 6px; text-shadow: 0 1px 8px rgba(0,0,0,0.6);
    display: -webkit-box; -webkit-line-clamp: 2;
    -webkit-box-orient: vertical; overflow: hidden;
  }
  .item-actress { font-size: 13px; color: rgba(255,255,255,0.75); margin-bottom: 16px; }
  .cta-buttons { display: flex; gap: 10px; flex-wrap: wrap; }
  .btn-detail, .btn-buy {
    display: inline-block; padding: 12px 22px; border-radius: 10px;
    font-size: 14px; font-weight: 700; text-decoration: none;
    text-align: center; min-height: 44px;
    transition: opacity 0.15s ease, transform 0.15s ease;
  }
  .btn-detail:active, .btn-buy:active { opacity: 0.75; transform: scale(0.97); }
  .btn-detail {
    background: rgba(255,255,255,0.18);
    border: 1px solid rgba(255,255,255,0.4);
    backdrop-filter: blur(8px); color: #fff; flex: 1;
  }
  .btn-buy { background: #e91e63; color: #fff; flex: 1; }
  @media (prefers-reduced-motion: reduce) { .scroll-hint { animation: none; } }
`;
