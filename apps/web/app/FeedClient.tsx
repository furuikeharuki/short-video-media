"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FeedItem from "@/components/FeedItem";
import { sortBySeenStatus, markSeen, getSeenIds, clearSeen, shuffle } from "@/lib/feedOrder";
import type { MovieCard } from "@/lib/api/feed";

interface Props {
  initialItems: MovieCard[];
}

export default function FeedClient({ initialItems }: Props) {
  const [items, setItems] = useState<MovieCard[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const seenCountRef = useRef(0);

  // マウント時に localStorage を参照して並び替え
  useEffect(() => {
    setItems(sortBySeenStatus(initialItems));
  }, [initialItems]);

  // 各アイテムが 85%以上表示されたら seen 記録、全視聴済みなら次のセットを术に追加
  const rebuildObserver = useCallback((currentItems: MovieCard[]) => {
    observerRef.current?.disconnect();

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const id = (entry.target as HTMLElement).dataset.movieId;
          if (!id) return;

          const seen = getSeenIds();
          if (!seen.has(id)) {
            markSeen(id);
            seenCountRef.current += 1;
          }

          // 残り未視聴が 1 以下になったら次のセットを术に追加
          const newSeen = getSeenIds();
          const remainingUnseen = currentItems.filter((i) => !newSeen.has(i.id));
          if (remainingUnseen.length <= 1) {
            clearSeen();
            seenCountRef.current = 0;
            const nextBatch = shuffle(currentItems);
            setItems((prev) => [...prev, ...nextBatch]);
          }
        });
      },
      { threshold: 0.85 }
    );

    observerRef.current = observer;

    const sections = containerRef.current?.querySelectorAll<HTMLElement>(".feed-item[data-movie-id]");
    sections?.forEach((el) => observer.observe(el));
  }, []);

  useEffect(() => {
    if (items.length === 0) return;
    rebuildObserver(initialItems);
    return () => observerRef.current?.disconnect();
  }, [items, initialItems, rebuildObserver]);

  if (items.length === 0) {
    return (
      <main className="empty-state">
        <div className="empty-inner">
          <p className="empty-icon">🎦</p>
          <h2>まだ作品がありません</h2>
          <p>しばらくしてから再度ご確認ください。</p>
        </div>
      </main>
    );
  }

  return (
    <div ref={containerRef} className="feed-container">
      {items.map((item, index) => (
        <FeedItem
          key={`${item.id}-${index}`}
          item={item}
          isFirst={index === 0}
          isSecond={index === 1}
        />
      ))}
    </div>
  );
}
