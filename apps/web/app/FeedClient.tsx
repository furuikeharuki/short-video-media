"use client";

import { useEffect, useRef, useState } from "react";
import FeedItem from "@/components/FeedItem";
import { sortBySeenStatus, markSeen } from "@/lib/feedOrder";
import type { MovieCard } from "@/lib/api/feed";

interface Props {
  initialItems: MovieCard[];
}

export default function FeedClient({ initialItems }: Props) {
  const [items, setItems] = useState<MovieCard[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // マウント時に localStorage を参照して並び替え
  useEffect(() => {
    setItems(sortBySeenStatus(initialItems));
  }, [initialItems]);

  // 各アイテムが 85% 以上表示されたら seen として記録
  useEffect(() => {
    if (items.length === 0) return;

    observerRef.current?.disconnect();

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const id = (entry.target as HTMLElement).dataset.movieId;
            if (id) markSeen(id);
          }
        });
      },
      { threshold: 0.85 }
    );

    observerRef.current = observer;

    const sections = containerRef.current?.querySelectorAll<HTMLElement>(".feed-item[data-movie-id]");
    sections?.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [items]);

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
          key={item.id}
          item={item}
          isFirst={index === 0}
          isSecond={index === 1}
        />
      ))}
    </div>
  );
}
