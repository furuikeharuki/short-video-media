"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FeedItem from "@/components/FeedItem";
import { markSeen, getOrCreateSeed } from "@/lib/feedOrder";
import { getFeed } from "@/lib/api/feed";
import type { MovieCard } from "@/lib/api/feed";

const WINDOW_SIZE   = 2;
const PRELOAD_AHEAD = 2;
const PRELOAD_BYTES = 2 * 1024 * 1024;

const preloadCache = new Set<string>();

function prefetchVideo(url: string, abortSignal: AbortSignal) {
  if (preloadCache.has(url)) return;
  preloadCache.add(url);
  fetch(url, {
    method: "GET",
    headers: { Range: `bytes=0-${PRELOAD_BYTES - 1}` },
    signal: abortSignal,
  }).catch(() => { preloadCache.delete(url); });
}

export default function FeedClient() {
  const allItemsRef     = useRef<MovieCard[]>([]);
  const nextCursorRef   = useRef<string | null>(null);
  const seedRef         = useRef<number | null>(null);
  const isFetchingRef   = useRef(false);
  const currentIdxRef   = useRef(0);
  const wheelLockRef    = useRef(false);
  const containerRef    = useRef<HTMLDivElement>(null);
  const preloadAbortRef = useRef<AbortController | null>(null);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [windowItems, setWindowItems]   = useState<MovieCard[]>([]);
  const [isEmpty, setIsEmpty]           = useState(false);
  const [isLoading, setIsLoading]       = useState(false);
  const windowStartRef = useRef(0);

  const [dragPx, setDragPx] = useState(0);
  const dragStartY = useRef(0);
  const isDragging = useRef(false);

  const updateWindow = useCallback((idx: number) => {
    const all   = allItemsRef.current;
    const start = Math.max(0, idx - WINDOW_SIZE);
    const end   = Math.min(all.length, idx + WINDOW_SIZE + 1);
    windowStartRef.current = start;
    setWindowItems(all.slice(start, end));

    preloadAbortRef.current?.abort();
    const controller = new AbortController();
    preloadAbortRef.current = controller;
    for (let i = 1; i <= PRELOAD_AHEAD; i++) {
      const ahead = all[idx + i];
      if (ahead?.sample_movie_url) prefetchVideo(ahead.sample_movie_url, controller.signal);
    }
  }, []);

  const fetchInitial = useCallback(async (overrideCursor?: string, overrideSeed?: number) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      const cursor = overrideCursor ?? "0";
      const seed   = overrideSeed   ?? seedRef.current ?? 0;
      const res = await getFeed(parseInt(cursor, 10), 20, seed);
      allItemsRef.current   = res.items;
      nextCursorRef.current = res.next_cursor;
      currentIdxRef.current = 0;
      setCurrentIndex(0);
      setIsEmpty(res.items.length === 0);
      updateWindow(0);
    } catch (e) {
      console.error("fetchInitial failed", e);
    } finally {
      isFetchingRef.current = false;
      setIsLoading(false);
    }
  }, [updateWindow]);

  useEffect(() => {
    const seed = getOrCreateSeed();
    seedRef.current = seed;
    fetchInitial("0", seed);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goNext = useCallback(async () => {
    const all = allItemsRef.current;
    const currentItem = all[currentIdxRef.current];
    const nextIdx = currentIdxRef.current + 1;
    if (nextIdx >= all.length) return;
    if (currentItem) markSeen(currentItem.id);
    currentIdxRef.current = nextIdx;
    setCurrentIndex(nextIdx);
    updateWindow(nextIdx);
  }, [updateWindow]);

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

    let startY = 0;
    let startTime = 0;

    const onTouchStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY;
      startTime = Date.now();
      isDragging.current = true;
      dragStartY.current = startY;
      setDragPx(0);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!isDragging.current) return;
      const dy = e.touches[0].clientY - dragStartY.current;
      const atEnd = currentIdxRef.current >= allItemsRef.current.length - 1;
      const atTop = currentIdxRef.current <= 0;
      // 端以外は全スライド追従させる（隣が見えるように dragPx を常に更新）
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
      const dy = e.changedTouches[0].clientY - startY;
      const dt = Date.now() - startTime;
      if (Math.abs(dy) > 60 && dt < 500) {
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
    el.addEventListener("touchmove",   onTouchMove,   { passive: true });
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

  useEffect(() => {
    if (windowItems.length === 0 && !isFetchingRef.current && !isEmpty) fetchInitial();
  }, [windowItems, fetchInitial, isEmpty]);

  const showEmpty   = isEmpty && !isLoading;
  const showLoading = isLoading || (windowItems.length === 0 && !isEmpty);

  const isDraggingState = dragPx !== 0;

  return (
    <div ref={containerRef} className="feed-container">
      {showEmpty ? (
        <div className="feed-empty">
          <p className="feed-empty-text">該当する作品が見つかりませんでした</p>
        </div>
      ) : showLoading ? (
        <div className="feed-loading">
          <div className="feed-spinner" />
        </div>
      ) : (
        windowItems.map((item, i) => {
          const absIndex = windowStartRef.current + i;
          const offset   = absIndex - currentIndex;

          // dragPx を全スライドに適用して連動させる
          const transform = `translateY(calc(${offset * 100}% + ${dragPx}px))`;

          // ドラッグ中はアニメーション無効、離した瞬間にスナップ
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
                // visibility なし：非アクティブスライドも常時表示されスクロール中に覚ぎる
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
  .feed-empty {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    background: #000;
  }
  .feed-empty-text {
    font-size: 15px;
    color: rgba(255,255,255,0.5);
  }
`;
