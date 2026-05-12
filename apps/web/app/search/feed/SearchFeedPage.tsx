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

  const [items, setItems]     = useState<MovieCard[]>([]);
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

  useEffect(() => {
    if (items.length > 0 && containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [items]);

  if (loading) {
    return (
      <div style={styles.center}>
        <span style={styles.spinner} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (items.length === 0) {
    return <div style={styles.center}>該当する作品が見つかりませんでした</div>;
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
  center: {
    position: "fixed" as const,
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#000",
    color: "rgba(255,255,255,0.4)",
    fontSize: "14px",
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
  @keyframes spin { to { transform: rotate(360deg); } }
`;
