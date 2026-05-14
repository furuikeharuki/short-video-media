"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FeedItem from "@/components/FeedItem";
import { markSeen, getOrCreateSeed, resetSeed } from "@/lib/feedOrder";
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
  const activeGenresRef = useRef<string[]>([]);

  const bgFetchPromiseRef = useRef<Promise<void> | null>(null);
  const pendingItemsRef   = useRef<MovieCard[] | null>(null);
  const pendingCursorRef  = useRef<string | null>(null);
  const pendingSeedRef    = useRef<number | null>(null);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [windowItems, setWindowItems]   = useState<MovieCard[]>([]);
  const [activeGenres, setActiveGenres] = useState<string[]>([]);
  const [currentGenres, setCurrentGenres] = useState<string[]>([]);
  const [isEmpty, setIsEmpty]           = useState(false);
  const [isLoading, setIsLoading]       = useState(false);
  const windowStartRef = useRef(0);

  // ラバーバンド用: アクティブスライドの追加オフセット(px)
  const [dragPx, setDragPx]   = useState(0);
  const dragStartY  = useRef(0);
  const isDragging  = useRef(false);

  const updateWindow = useCallback((idx: number) => {
    const all   = allItemsRef.current;
    const start = Math.max(0, idx - WINDOW_SIZE);
    const end   = Math.min(all.length, idx + WINDOW_SIZE + 1);
    windowStartRef.current = start;
    setWindowItems(all.slice(start, end));
    setCurrentGenres(all[idx]?.genres ?? []);

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
      const genres = activeGenresRef.current;
      const res = await getFeed(
        parseInt(cursor, 10), 20, seed,
        genres.length > 0 ? genres : undefined,
      );
      allItemsRef.current   = res.items;
      nextCursorRef.current = res.next_cursor;
      currentIdxRef.current = 0;
      setCurrentIndex(0);
      setIsEmpty(res.items.length === 0);
      setCurrentGenres(res.items[0]?.genres ?? []);
      updateWindow(0);
    } catch (e) {
      console.error("fetchInitial failed", e);
    } finally {
      isFetchingRef.current = false;
      setIsLoading(false);
    }
  }, [updateWindow]);

  const fetchBackground = useCallback((genres: string[]) => {
    pendingItemsRef.current  = null;
    pendingCursorRef.current = null;
    pendingSeedRef.current   = null;

    const promise = (async () => {
      try {
        const seed = resetSeed();
        pendingSeedRef.current = seed;
        const res = await getFeed(
          0, 20, seed,
          genres.length > 0 ? genres : undefined,
        );
        pendingItemsRef.current  = res.items;
        pendingCursorRef.current = res.next_cursor;
      } catch (e) {
        console.error("fetchBackground failed", e);
      }
    })();

    bgFetchPromiseRef.current = promise;
    return promise;
  }, []);

  const handleGenreToggle = useCallback((tag: string) => {
    const current = activeGenresRef.current;
    const next = current.includes(tag)
      ? current.filter((g) => g !== tag)
      : [...current, tag];
    activeGenresRef.current = next;
    setActiveGenres([...next]);
    fetchBackground(next);
  }, [fetchBackground]);

  useEffect(() => {
    const seed = getOrCreateSeed();
    seedRef.current = seed;
    fetchInitial("0", seed);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goNext = useCallback(async () => {
    const all = allItemsRef.current;
    const currentItem = all[currentIdxRef.current];

    if (bgFetchPromiseRef.current) {
      await bgFetchPromiseRef.current;
      bgFetchPromiseRef.current = null;
    }

    if (pendingItemsRef.current && pendingItemsRef.current.length > 0) {
      const filtered = pendingItemsRef.current.filter(
        (item) => item.id !== currentItem?.id
      );
      pendingItemsRef.current  = null;
      pendingCursorRef.current = null;
      pendingSeedRef.current   = null;
      isFetchingRef.current    = false;

      if (filtered.length > 0) {
        allItemsRef.current   = currentItem ? [currentItem, ...filtered] : filtered;
        nextCursorRef.current = null;
        if (currentItem) markSeen(currentItem.id);
        currentIdxRef.current = 1;
        setCurrentIndex(1);
        updateWindow(1);
        return;
      }
    }

    const nextIdx = currentIdxRef.current + 1;
    if (nextIdx >= all.length) return; // 末尾では何もしない（ラバーバンドは touchイベント側で実装）

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

  // タッチイベント: 末尾・先頭のみラバーバンド、それ以外は遷移
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const isAtEnd  = () => currentIdxRef.current >= allItemsRef.current.length - 1;
    const isAtTop  = () => currentIdxRef.current <= 0;

    let startY = 0;
    let startTime = 0;

    const onTouchStart = (e: TouchEvent) => {
      startY    = e.touches[0].clientY;
      startTime = Date.now();
      isDragging.current  = true;
      dragStartY.current  = startY;
      setDragPx(0);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!isDragging.current) return;
      const dy = e.touches[0].clientY - dragStartY.current;
      // 末尾で下に引っ張る(プラスdy) / 先頭で上に引っ張る(マイナスdy) のみラバーバンド
      if ((dy > 0 && isAtEnd()) || (dy < 0 && isAtTop())) {
        setDragPx(dy * 0.35);
      } else {
        setDragPx(0);
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!isDragging.current) return;
      isDragging.current = false;
      setDragPx(0); // スプリングで戻る

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

  return (
    <>
      <div className="genre-bar" role="toolbar" aria-label="ジャンル絞り込み">
        {currentGenres.length > 0 ? (
          currentGenres.map((tag) => (
            <button
              key={tag}
              className={`genre-chip${activeGenres.includes(tag) ? " active" : ""}`}
              onClick={() => handleGenreToggle(tag)}
              aria-pressed={activeGenres.includes(tag)}
            >
              {tag}
            </button>
          ))
        ) : (
          !showEmpty && (
            <>
              <div className="genre-chip-skeleton" style={{ width: 52 }} />
              <div className="genre-chip-skeleton" style={{ width: 44 }} />
              <div className="genre-chip-skeleton" style={{ width: 60 }} />
            </>
          )
        )}
      </div>

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
            const isActive = offset === 0;
            // アクティブスライドにのみラバーバンドオフセットを足す
            const transform = isActive
              ? `translateY(calc(${offset * 100}% + ${dragPx}px))`
              : `translateY(${offset * 100}%)`;
            return (
              <div
                key={`${item.id}-${absIndex}`}
                className="feed-slide"
                style={{
                  transform,
                  transition:    isActive && dragPx === 0
                    ? "transform 0.35s cubic-bezier(0.25,1,0.5,1)"
                    : isActive
                    ? "none"
                    : undefined,
                  zIndex:        isActive ? 2 : 1,
                  pointerEvents: isActive ? "auto" : "none",
                  visibility:    isActive ? "visible" : "hidden",
                }}
              >
                <FeedItem
                  item={item}
                  isFirst={absIndex === 0}
                  isSecond={absIndex === 1}
                  activeGenres={activeGenres}
                  onGenreClick={handleGenreToggle}
                />
              </div>
            );
          })
        )}
        <style>{spinnerStyle}</style>
      </div>
    </>
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
  .genre-bar {
    position: fixed;
    top: 52px;
    left: 0; right: 0;
    z-index: 100;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 12px 10px;
    background: linear-gradient(to bottom, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0) 100%);
  }
  .genre-chip {
    flex-shrink: 0;
    padding: 5px 13px;
    border-radius: 999px;
    border: 1px solid rgba(255,255,255,0.3);
    background: rgba(255,255,255,0.1);
    color: rgba(255,255,255,0.8);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    -webkit-tap-highlight-color: transparent;
    line-height: 1.4;
    min-height: 30px;
  }
  .genre-chip.active {
    background: #e91e63;
    border-color: #e91e63;
    color: #fff;
  }
  .genre-chip:active { opacity: 0.75; }
  .genre-chip-skeleton {
    flex-shrink: 0;
    height: 28px;
    border-radius: 999px;
    background: rgba(255,255,255,0.1);
    animation: skel-pulse 1.2s ease-in-out infinite;
  }
  @keyframes skel-pulse {
    0%, 100% { opacity: 0.5; }
    50%       { opacity: 1; }
  }
  @media (min-width: 640px) {
    .genre-bar { padding: 10px 20px 12px; gap: 8px; }
    .genre-chip { font-size: 13px; padding: 6px 16px; min-height: 34px; }
  }
`;
