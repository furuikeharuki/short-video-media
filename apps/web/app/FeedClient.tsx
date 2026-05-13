"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FeedItem from "@/components/FeedItem";
import { markSeen, getSeenIds, getOrCreateSeed, resetSeed } from "@/lib/feedOrder";
import { getFeed } from "@/lib/api/feed";
import type { MovieCard } from "@/lib/api/feed";

/** DOM上に保持する前後の件数 */
const WINDOW_SIZE = 2; // 前2件 + 現在 + 後2件 = 最大 5件
const PREFETCH_AHEAD = 5; // 残リが5件以下になったら次バッチを取得

interface Props {
  initialItems: MovieCard[];
  initialNextCursor: string | null;
  initialSeed: number;
}

export default function FeedClient({ initialItems, initialNextCursor, initialSeed }: Props) {
  // 全データバッファ（DOMには出さない）
  const allItemsRef = useRef<MovieCard[]>(initialItems);
  const nextCursorRef = useRef<string | null>(initialNextCursor);
  const seedRef = useRef<number>(initialSeed);
  const isFetchingRef = useRef(false);

  // 現在表示中のインデックス（allItems内）
  const [currentIndex, setCurrentIndex] = useState(0);
  // DOMに渡すウィンドウ山のアイテム
  const [windowItems, setWindowItems] = useState<MovieCard[]>(initialItems.slice(0, WINDOW_SIZE * 2 + 1));
  // window内先頭のallItemsインデックス
  const windowStartRef = useRef(0);

  const containerRef = useRef<HTMLDivElement>(null);

  // windowを再計算してセット
  const updateWindow = useCallback((idx: number) => {
    const all = allItemsRef.current;
    const start = Math.max(0, idx - WINDOW_SIZE);
    const end = Math.min(all.length, idx + WINDOW_SIZE + 1);
    windowStartRef.current = start;
    setWindowItems(all.slice(start, end));
  }, []);

  // 次バッチを取得して allItems に追加
  const fetchMore = useCallback(async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      let cursor = nextCursorRef.current;
      let seed = seedRef.current;

      // cursorがない = 全周完了 → seenリセットして最初から
      if (cursor === null) {
        seed = resetSeed();
        seedRef.current = seed;
        cursor = "0";
      }

      const res = await getFeed(parseInt(cursor, 10), 20, seed);
      allItemsRef.current = [...allItemsRef.current, ...res.items];
      nextCursorRef.current = res.next_cursor;
    } catch (e) {
      console.error("fetchMore failed", e);
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  // スワイプでインデックス進展
  const goNext = useCallback(() => {
    setCurrentIndex((prev) => {
      const next = prev + 1;
      const all = allItemsRef.current;

      // seen記録
      const item = all[prev];
      if (item) markSeen(item.id);

      // 残りが PREFETCH_AHEAD 以下ならプリフェッチ
      if (all.length - next <= PREFETCH_AHEAD) {
        fetchMore();
      }

      updateWindow(next);
      return next;
    });
  }, [fetchMore, updateWindow]);

  const goPrev = useCallback(() => {
    setCurrentIndex((prev) => {
      const next = Math.max(0, prev - 1);
      updateWindow(next);
      return next;
    });
  }, [updateWindow]);

  // タッチスワイプ制御
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let startY = 0;
    let startTime = 0;

    const onTouchStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY;
      startTime = Date.now();
    };
    const onTouchEnd = (e: TouchEvent) => {
      const dy = startY - e.changedTouches[0].clientY;
      const dt = Date.now() - startTime;
      if (Math.abs(dy) > 50 && dt < 400) {
        if (dy > 0) goNext();
        else goPrev();
      }
    };
    // ホイールスクロール（PC）
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY > 30) goNext();
      else if (e.deltaY < -30) goPrev();
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("wheel", onWheel);
    };
  }, [goNext, goPrev]);

  // windowItems内の現在インデックス
  const windowIndex = currentIndex - windowStartRef.current;

  if (windowItems.length === 0) {
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
      {windowItems.map((item, i) => {
        const absIndex = windowStartRef.current + i;
        const offset = absIndex - currentIndex; // -2〜+2
        return (
          <div
            key={`${item.id}-${absIndex}`}
            className="feed-slide"
            style={{
              transform: `translateY(${offset * 100}%)`,
              zIndex: offset === 0 ? 1 : 0,
              pointerEvents: offset === 0 ? "auto" : "none",
            }}
          >
            <FeedItem
              item={item}
              isFirst={absIndex === 0}
              isSecond={absIndex === 1}
            />
          </div>
        );
      })}
    </div>
  );
}
