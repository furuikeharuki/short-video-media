"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import FeedItem from "@/components/FeedItem";
import type { MovieCard } from "@/lib/api/feed";

export default function SearchFeedPage() {
  const searchParams = useSearchParams();
  const start = Number(searchParams.get("start") ?? "0");
  const itemsParam = searchParams.get("items") ?? "";

  const items = useMemo<MovieCard[]>(() => {
    if (!itemsParam) return [];
    try {
      const arr: MovieCard[] = JSON.parse(decodeURIComponent(itemsParam));
      // startのインデックスから始まるよう並び替え
      return [...arr.slice(start), ...arr.slice(0, start)];
    } catch {
      return [];
    }
  }, [itemsParam, start]);

  if (items.length === 0) {
    return (
      <div style={styles.empty}>
        該当する作品が見つかりませんでした
      </div>
    );
  }

  return (
    <>
      <div className="feed-container">
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
`;
