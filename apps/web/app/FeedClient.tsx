"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FeedItem from "@/components/FeedItem";
import { markSeen, getOrCreateSeed } from "@/lib/feedOrder";
import { getFeed } from "@/lib/api/feed";
import type { MovieCard } from "@/lib/api/feed";

const WINDOW_SIZE   = 2;
const PRELOAD_AHEAD = 2;
const PRELOAD_BYTES = 2 * 1024 * 1024;

const FEED_SEED_KEY  = "feed_seed";
const FEED_INDEX_KEY = "feed_index";
const FEED_ITEMS_KEY = "feed_items";

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

function saveSession(seed: number, index: number, items: object[]) {
  try {
    sessionStorage.setItem(FEED_SEED_KEY,  String(seed));
    sessionStorage.setItem(FEED_INDEX_KEY, String(index));
    sessionStorage.setItem(FEED_ITEMS_KEY, JSON.stringify(items));
  } catch { /* ignore */ }
}

function loadSession(): { seed: number; index: number; items: object[] } | null {
  try {
    const seed  = sessionStorage.getItem(FEED_SEED_KEY);
    const index = sessionStorage.getItem(FEED_INDEX_KEY);
    const items = sessionStorage.getItem(FEED_ITEMS_KEY);
    if (!seed || !index || !items) return null;
    return {
      seed:  parseInt(seed, 10),
      index: parseInt(index, 10),
      items: JSON.parse(items),
    };
  } catch {
    return null;
  }
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
  const restoredRef     = useRef(false);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [windowItems, setWindowItems]   = useState<MovieCard[]>([]);
  const [isEmpty, setIsEmpty]           = useState(false);
  const [isLoading, setIsLoading]       = useState(false);
  const windowStartRef = useRef(0);

  const [dragPx, setDragPx] = useState(0);
  const dragStartY         = useRef(0);
  const dragStartYForEnd   = useRef(0);
  const dragStartTime      = useRef(0);
  const isDragging         = useRef(false);

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

  const fetchInitial = useCallback(async (seed: number, startIndex = 0) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      const res = await getFeed(0, 20, seed);
      allItemsRef.current   = res.items;
      nextCursorRef.current = res.next_cursor;
      const idx = Math.min(startIndex, res.items.length - 1);
      currentIdxRef.current = idx;
      setCurrentIndex(idx);
      setIsEmpty(res.items.length === 0);
      updateWindow(idx);
      saveSession(seed, idx, res.items);
    } catch (e) {
      console.error("fetchInitial failed", e);
    } finally {
      isFetchingRef.current = false;
      setIsLoading(false);
    }
  }, [updateWindow]);

  useEffect(() => {
    const session = loadSession();
    if (session && session.items.length > 0) {
      restoredRef.current = true;
      const items = session.items as MovieCard[];
      allItemsRef.current   = items;
      seedRef.current       = session.seed;
      const idx = Math.min(session.index, items.length - 1);
      currentIdxRef.current = idx;
      setCurrentIndex(idx);
      setIsEmpty(false);
      setIsLoading(false);
      updateWindow(idx);
    } else {
      const seed = getOrCreateSeed();
      seedRef.current = seed;
      fetchInitial(seed, 0);
    }
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
    try { sessionStorage.setItem(FEED_INDEX_KEY, String(nextIdx)); } catch { /* ignore */ }
  }, [updateWindow]);

  const goPrev = useCallback(() => {
    const next = Math.max(0, currentIdxRef.current - 1);
    if (next === currentIdxRef.current) return;
    currentIdxRef.current = next;
    setCurrentIndex(next);
    updateWindow(next);
    try { sessionStorage.setItem(FEED_INDEX_KEY, String(next)); } catch { /* ignore */ }
  }, [updateWindow]);

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
      const dy = e.touches[0].clientY - dragStartY.current;
      const atEnd = currentIdxRef.current >= allItemsRef.current.length - 1;
      const atTop = currentIdxRef.current <= 0;
      // 進めない方向（先頭で下・末尾で上）だけ35%減衰
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

  useEffect(() => {
    if (restoredRef.current) return;
    if (windowItems.length === 0 && !isFetchingRef.current && !isEmpty) {
      const seed = seedRef.current ?? getOrCreateSeed();
      fetchInitial(seed, 0);
    }
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
