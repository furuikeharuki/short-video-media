"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import FeedItem from "@/components/FeedItem";
import type { MovieCard } from "@/lib/api/feed";

const STORAGE_KEY     = "search_feed_items";
const STORAGE_KEY_IDX = "search_feed_index";
const WINDOW_SIZE     = 2;
const APPEND_AHEAD    = 5;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function SearchFeedPage() {
  const searchParams = useSearchParams();
  const selectedId   = searchParams.get("id") ?? null;

  const baseItemsRef  = useRef<MovieCard[]>([]);
  const allItemsRef   = useRef<MovieCard[]>([]);
  const currentIdxRef = useRef(0);
  const wheelLockRef  = useRef(false);

  const touchStartYRef = useRef(0);
  const touchTimeRef   = useRef(0);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [windowItems,  setWindowItems]  = useState<MovieCard[]>([]);
  const windowStartRef = useRef(0);

  const [dragPx, setDragPx] = useState(0);
  const dragStartY  = useRef(0);
  const isDragging  = useRef(false);

  const saveIndex = useCallback((idx: number) => {
    try { sessionStorage.setItem(STORAGE_KEY_IDX, String(idx)); } catch { /* ignore */ }
  }, []);

  const updateWindow = useCallback((idx: number) => {
    const all   = allItemsRef.current;
    const start = Math.max(0, idx - WINDOW_SIZE);
    const end   = Math.min(all.length, idx + WINDOW_SIZE + 1);
    windowStartRef.current = start;
    setWindowItems(all.slice(start, end));
  }, []);

  const maybeAppend = useCallback((idx: number) => {
    const all  = allItemsRef.current;
    const base = baseItemsRef.current;
    if (base.length === 0) return;
    if (all.length - idx <= APPEND_AHEAD) {
      allItemsRef.current = [...all, ...shuffle(base)];
    }
  }, []);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const arr: MovieCard[] = JSON.parse(raw);
      if (arr.length === 0) return;

      baseItemsRef.current = arr;

      // selectedId がある場合（グリッドからのタップ）→ そのアイテムを先頭に
      if (selectedId) {
        const selected = arr.find((m) => m.id === selectedId) ?? arr[0];
        const rest     = shuffle(arr.filter((m) => m.id !== selected.id));
        allItemsRef.current   = [selected, ...rest];
        currentIdxRef.current = 0;
        setCurrentIndex(0);
        saveIndex(0);
        updateWindow(0);
        return;
      }

      // 「戻る」場合（selectedId なし）→ 保存済み順番・位置を復元
      const savedIdx = parseInt(sessionStorage.getItem(STORAGE_KEY_IDX) ?? "0", 10);
      // items は順番を保持したまま使う（シャッフルしない）
      allItemsRef.current   = arr;
      const restoredIdx = Math.min(savedIdx, arr.length - 1);
      currentIdxRef.current = restoredIdx;
      setCurrentIndex(restoredIdx);
      updateWindow(restoredIdx);
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goNext = useCallback(() => {
    const next = currentIdxRef.current + 1;
    maybeAppend(next);
    if (next >= allItemsRef.current.length) return;
    currentIdxRef.current = next;
    setCurrentIndex(next);
    updateWindow(next);
    saveIndex(next);
  }, [maybeAppend, updateWindow, saveIndex]);

  const goPrev = useCallback(() => {
    const next = Math.max(0, currentIdxRef.current - 1);
    if (next === currentIdxRef.current) return;
    currentIdxRef.current = next;
    setCurrentIndex(next);
    updateWindow(next);
    saveIndex(next);
  }, [updateWindow, saveIndex]);

  // タッチ・ホイール (window バインド)
  useEffect(() => {
    const onTouchStart = (e: TouchEvent) => {
      touchStartYRef.current = e.touches[0].clientY;
      touchTimeRef.current   = Date.now();
      isDragging.current  = true;
      dragStartY.current  = e.touches[0].clientY;
      setDragPx(0);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!isDragging.current) return;
      const dy = e.touches[0].clientY - dragStartY.current;
      const atEnd = currentIdxRef.current >= allItemsRef.current.length - 1;
      const atTop = currentIdxRef.current <= 0;
      if ((dy > 0 && atEnd) || (dy < 0 && atTop)) {
        setDragPx(dy * 0.35);
      } else {
        setDragPx(dy);
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (!isDragging.current) return;
      isDragging.current = false;
      setDragPx(0);
      const dy = touchStartYRef.current - e.changedTouches[0].clientY;
      const dt = Date.now() - touchTimeRef.current;
      if (Math.abs(dy) > 40 && dt < 500) {
        if (dy > 0) goNext(); else goPrev();
      }
    };
    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".feed-container")) return;
      e.preventDefault();
      if (wheelLockRef.current) return;
      wheelLockRef.current = true;
      setTimeout(() => { wheelLockRef.current = false; }, 300);
      if (e.deltaY > 0) goNext(); else goPrev();
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove",  onTouchMove,  { passive: true });
    window.addEventListener("touchend",   onTouchEnd,   { passive: true });
    window.addEventListener("wheel",      onWheel,      { passive: false, capture: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove",  onTouchMove);
      window.removeEventListener("touchend",   onTouchEnd);
      window.removeEventListener("wheel",      onWheel, { capture: true } as EventListenerOptions);
    };
  }, [goNext, goPrev]);

  if (windowItems.length === 0) {
    return (
      <div style={styles.empty}>
        該当する作品が見つかりませんでした
      </div>
    );
  }

  const isDraggingState = dragPx !== 0;

  return (
    <>
      <div className="feed-container">
        {windowItems.map((item, i) => {
          const absIndex = windowStartRef.current + i;
          const offset   = absIndex - currentIndex;
          const transform  = `translateY(calc(${offset * 100}% + ${dragPx}px))`;
          const transition = isDraggingState
            ? "none"
            : "transform 0.35s cubic-bezier(0.25,1,0.5,1)";
          return (
            <div
              key={`${item.id}-${absIndex}`}
              className="feed-slide"
              style={{
                transform,
                transition,
                zIndex:        offset === 0 ? 2 : 1,
                pointerEvents: offset === 0 ? "auto" : "none",
              }}
            >
              <FeedItem item={item} isFirst={absIndex === 0} isSecond={absIndex === 1} />
            </div>
          );
        })}
      </div>
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
    top: var(--header-h, 52px);
    left: 0; right: 0; bottom: 0;
    overflow: hidden;
  }

  .feed-slide {
    position: absolute;
    inset: 0;
    will-change: transform;
  }

  .feed-item {
    position: relative;
    width: 100%;
    height: 100%;
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
`;
