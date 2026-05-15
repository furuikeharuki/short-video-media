"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import FeedItem from "@/components/FeedItem";
import type { MovieCard } from "@/lib/api/feed";

const STORAGE_KEY  = "search_feed_items";
const WINDOW_SIZE  = 2;
const APPEND_AHEAD = 5;

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
  const containerRef  = useRef<HTMLDivElement>(null);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [windowItems,  setWindowItems]  = useState<MovieCard[]>([]);
  const [isEmpty,      setIsEmpty]      = useState(false);
  const windowStartRef = useRef(0);

  // ドラッグ追従
  const [dragPx,          setDragPx]        = useState(0);
  const dragStartY        = useRef(0);
  const dragStartYForEnd  = useRef(0);
  const dragStartTime     = useRef(0);
  const isDragging        = useRef(false);

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
      if (arr.length === 0) { setIsEmpty(true); return; }
      const selected = (selectedId ? arr.find((m) => m.id === selectedId) : null) ?? arr[0];
      const rest     = shuffle(arr.filter((m) => m.id !== selected.id));
      const initial  = [selected, ...rest];
      baseItemsRef.current  = arr;
      allItemsRef.current   = initial;
      currentIdxRef.current = 0;
      setCurrentIndex(0);
      updateWindow(0);
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goNext = useCallback(() => {
    const all     = allItemsRef.current;
    const nextIdx = currentIdxRef.current + 1;
    // 末尾で止まる（無限スクロール禁止）
    if (nextIdx >= all.length) return;
    maybeAppend(nextIdx);
    currentIdxRef.current = nextIdx;
    setCurrentIndex(nextIdx);
    updateWindow(nextIdx);
  }, [maybeAppend, updateWindow]);

  const goPrev = useCallback(() => {
    const next = Math.max(0, currentIdxRef.current - 1);
    if (next === currentIdxRef.current) return;
    currentIdxRef.current = next;
    setCurrentIndex(next);
    updateWindow(next);
  }, [updateWindow]);

  // コンテナにバインド（window 全体でなく）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      const y = e.touches[0].clientY;
      isDragging.current       = true;
      dragStartY.current       = y;
      dragStartYForEnd.current = y;
      dragStartTime.current    = Date.now();
      setDragPx(0);
    };

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (!isDragging.current) return;
      const dy    = e.touches[0].clientY - dragStartY.current;
      const atEnd = currentIdxRef.current >= allItemsRef.current.length - 1;
      const atTop = currentIdxRef.current <= 0;
      if ((dy > 0 && atTop) || (dy < 0 && atEnd)) {
        setDragPx(dy * 0.35);
      } else {
        setDragPx(dy);
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!isDragging.current) return;
      isDragging.current = false;
      setDragPx(0);
      const dy = e.changedTouches[0].clientY - dragStartYForEnd.current;
      const dt = Date.now() - dragStartTime.current;
      if (Math.abs(dy) > 60 && dt < 1000) {
        if (dy < 0) goNext();
        else        goPrev();
      }
    };

    const onTouchCancel = () => {
      isDragging.current = false;
      setDragPx(0);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (wheelLockRef.current) return;
      wheelLockRef.current = true;
      setTimeout(() => { wheelLockRef.current = false; }, 300);
      if (e.deltaY > 0) goNext(); else goPrev();
    };

    el.addEventListener("touchstart",  onTouchStart,  { passive: true });
    el.addEventListener("touchmove",   onTouchMove,   { passive: false });
    el.addEventListener("touchend",    onTouchEnd,    { passive: true });
    el.addEventListener("touchcancel", onTouchCancel, { passive: true });
    el.addEventListener("wheel",       onWheel,       { passive: false });
    return () => {
      el.removeEventListener("touchstart",  onTouchStart);
      el.removeEventListener("touchmove",   onTouchMove);
      el.removeEventListener("touchend",    onTouchEnd);
      el.removeEventListener("touchcancel", onTouchCancel);
      el.removeEventListener("wheel",       onWheel);
    };
  }, [goNext, goPrev]);

  if (isEmpty) {
    return (
      <div style={styles.empty}>
        該当する作品が見つかりませんでした
      </div>
    );
  }

  if (windowItems.length === 0) {
    return (
      <div style={styles.empty}>
        読み込み中...
      </div>
    );
  }

  const isDraggingState = dragPx !== 0;

  return (
    <>
      <div ref={containerRef} className="feed-container">
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
    left: 0; right: 0;
    bottom: var(--bottom-nav-h, 56px);
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
  .thumbnail-bg { position: absolute; inset: 0; }
  .thumbnail-img { width: 100%; height: 100%; object-fit: cover; display: block; }
`;
