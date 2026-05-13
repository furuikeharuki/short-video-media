"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FeedItem from "@/components/FeedItem";
import { markSeen, getOrCreateSeed, resetSeed } from "@/lib/feedOrder";
import { getFeed } from "@/lib/api/feed";
import type { MovieCard } from "@/lib/api/feed";

const WINDOW_SIZE    = 2;
const PREFETCH_AHEAD = 8;

interface Props {
  initialItems: MovieCard[];
  initialNextCursor: string | null;
}

export default function FeedClient({ initialItems, initialNextCursor }: Props) {
  const allItemsRef    = useRef<MovieCard[]>(initialItems);
  const nextCursorRef  = useRef<string | null>(initialNextCursor);
  const seedRef        = useRef<number | null>(null); // null = 未初期化
  const isFetchingRef  = useRef(false);
  const currentIdxRef  = useRef(0);
  const wheelLockRef   = useRef(false);
  const containerRef   = useRef<HTMLDivElement>(null);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [windowItems, setWindowItems]   = useState<MovieCard[]>(
    () => initialItems.slice(0, Math.min(WINDOW_SIZE * 2 + 1, initialItems.length))
  );
  const windowStartRef = useRef(0);

  const updateWindow = useCallback((idx: number) => {
    const all   = allItemsRef.current;
    const start = Math.max(0, idx - WINDOW_SIZE);
    const end   = Math.min(all.length, idx + WINDOW_SIZE + 1);
    windowStartRef.current = start;
    setWindowItems(all.slice(start, end));
  }, []);

  const fetchMore = useCallback(async (overrideCursor?: string, overrideSeed?: number) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      let cursor = overrideCursor ?? nextCursorRef.current;
      let seed   = overrideSeed   ?? seedRef.current ?? 0;

      if (cursor === null) {
        seed   = resetSeed();
        seedRef.current       = seed;
        nextCursorRef.current = "0";
        cursor = "0";
      }

      const res = await getFeed(parseInt(cursor, 10), 20, seed);

      if (overrideCursor === "0") {
        // ランダム初期化時は一括差し替え
        allItemsRef.current = res.items;
        currentIdxRef.current = 0;
        setCurrentIndex(0);
      } else {
        allItemsRef.current = [...allItemsRef.current, ...res.items];
      }

      nextCursorRef.current = res.next_cursor;
      updateWindow(currentIdxRef.current);
    } catch (e) {
      console.error("fetchMore failed", e);
    } finally {
      isFetchingRef.current = false;
    }
  }, [updateWindow]);

  // マウント時: seed を得てランダム順で最初の20件を再取得
  useEffect(() => {
    const seed = getOrCreateSeed();
    seedRef.current = seed;
    // SSRで取得したID順データをランダム順で上書き
    fetchMore("0", seed);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goNext = useCallback(() => {
    const all  = allItemsRef.current;
    const next = currentIdxRef.current + 1;

    if (all.length - next <= PREFETCH_AHEAD) {
      fetchMore();
    }
    if (next >= all.length) return;

    const item = all[currentIdxRef.current];
    if (item) markSeen(item.id);

    currentIdxRef.current = next;
    setCurrentIndex(next);
    updateWindow(next);
  }, [fetchMore, updateWindow]);

  const goPrev = useCallback(() => {
    const next = Math.max(0, currentIdxRef.current - 1);
    if (next === currentIdxRef.current) return;
    currentIdxRef.current = next;
    setCurrentIndex(next);
    updateWindow(next);
  }, [updateWindow]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let startY = 0, startTime = 0;

    const onTouchStart = (e: TouchEvent) => {
      startY    = e.touches[0].clientY;
      startTime = Date.now();
    };
    const onTouchEnd = (e: TouchEvent) => {
      const dy = startY - e.changedTouches[0].clientY;
      const dt = Date.now() - startTime;
      if (Math.abs(dy) > 40 && dt < 500) {
        if (dy > 0) goNext();
        else        goPrev();
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (wheelLockRef.current) return;
      wheelLockRef.current = true;
      setTimeout(() => { wheelLockRef.current = false; }, 300);
      if (e.deltaY > 0) goNext();
      else              goPrev();
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchend",   onTouchEnd,   { passive: true });
    el.addEventListener("wheel",      onWheel,      { passive: false });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchend",   onTouchEnd);
      el.removeEventListener("wheel",      onWheel);
    };
  }, [goNext, goPrev]);

  // 空ガード
  useEffect(() => {
    if (windowItems.length === 0 && !isFetchingRef.current) {
      fetchMore();
    }
  }, [windowItems, fetchMore]);

  return (
    <div ref={containerRef} className="feed-container">
      {windowItems.length === 0 ? (
        <div className="feed-loading">
          <div className="feed-spinner" />
        </div>
      ) : (
        windowItems.map((item, i) => {
          const absIndex = windowStartRef.current + i;
          const offset   = absIndex - currentIndex;
          return (
            <div
              key={`${item.id}-${absIndex}`}
              className="feed-slide"
              style={{
                transform:     `translateY(${offset * 100}%)`,
                zIndex:        offset === 0 ? 1 : 0,
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
        })
      )}
      <style>{spinnerStyle}</style>
    </div>
  );
}

const spinnerStyle = `
  .feed-loading {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    background: #000;
  }
  .feed-spinner {
    width: 40px; height: 40px;
    border: 3px solid rgba(255,255,255,0.15);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
`;
