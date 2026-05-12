"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import FeedItem from "@/components/FeedItem";
import type { MovieCard } from "@/lib/api/feed";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000";

export default function SearchFeedPage() {
  const searchParams = useSearchParams();
  const query  = searchParams.get("q") ?? "";
  const start  = Number(searchParams.get("start") ?? "0");

  const [items, setItems]   = useState<MovieCard[]>([]);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchItems = useCallback(async () => {
    if (!query) return;
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/v1/search?q=${encodeURIComponent(query)}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error();
      const data = await res.json();
      // startのインデックスから始まるよう並び替え
      const arr: MovieCard[] = data.items ?? [];
      const reordered = [...arr.slice(start), ...arr.slice(0, start)];
      setItems(reordered);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [query, start]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  // コンテナがマウントされた後、1番目のアイテムにスクロール
  useEffect(() => {
    if (items.length > 0 && containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [items]);

  if (loading) {
    return (
      <div style={styles.loading}>
        <span style={styles.spinner} />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div style={styles.empty}>該当する作品が見つかりませんでした</div>
    );
  }

  return (
    <>
      <div ref={containerRef} className="feed-container">
        {items.map((item, index) => (
          <FeedItem
            key={item.id}
            item={item}
            isFirst={index === 0}
            isSecond={index === 1}
          />
        ))}
      </div>
      <style>{feedCSS}</style>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  loading: {
    position: "fixed" as const,
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#000",
  },
  spinner: {
    width: "36px",
    height: "36px",
    border: "3px solid rgba(255,255,255,0.15)",
    borderTop: "3px solid #fff",
    borderRadius: "50%",
    display: "inline-block",
    animation: "spin 0.8s linear infinite",
  },
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

const feedCSS = `
  html, body { background: #000 !important; overflow: hidden !important; }
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
  .thumbnail-bg { position: absolute; inset: 0; }
  .thumbnail-img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .info-overlay {
    position: absolute; bottom: 0; left: 0; right: 0;
    padding: 0 16px 32px; color: #fff; z-index: 10;
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
    background: rgba(255,255,255,0.18); border: 1px solid rgba(255,255,255,0.4);
    backdrop-filter: blur(8px); color: #fff; flex: 1;
  }
  .btn-buy { background: #e91e63; color: #fff; flex: 1; }
  @keyframes spin { to { transform: rotate(360deg); } }
`;
