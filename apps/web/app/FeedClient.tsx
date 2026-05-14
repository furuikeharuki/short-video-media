"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FeedItem from "@/components/FeedItem";
import { markSeen, getOrCreateSeed, resetSeed } from "@/lib/feedOrder";
import { getFeed } from "@/lib/api/feed";
import type { MovieCard } from "@/lib/api/feed";

const WINDOW_SIZE    = 2;
const PREFETCH_AHEAD = 8;
const PRELOAD_AHEAD  = 2;
const PRELOAD_BYTES  = 2 * 1024 * 1024;

const GENRE_TAGS = [
  "ビーナス", "素人", "美少女", "巨乳", "中出し",
  "OL", "ハード系", "VR", "耶婦", "プロ作品",
];

const preloadCache = new Set<string>();

function prefetchVideo(url: string, abortSignal: AbortSignal) {
  if (preloadCache.has(url)) return;
  preloadCache.add(url);
  fetch(url, {
    method: "GET",
    headers: { Range: `bytes=0-${PRELOAD_BYTES - 1}` },
    signal: abortSignal,
  }).catch(() => {
    preloadCache.delete(url);
  });
}

export default function FeedClient() {
  const allItemsRef    = useRef<MovieCard[]>([]);
  const nextCursorRef  = useRef<string | null>(null);
  const seedRef        = useRef<number | null>(null);
  const isFetchingRef  = useRef(false);
  const currentIdxRef  = useRef(0);
  const wheelLockRef   = useRef(false);
  const containerRef   = useRef<HTMLDivElement>(null);
  const preloadAbortRef = useRef<AbortController | null>(null);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [windowItems, setWindowItems]   = useState<MovieCard[]>([]);
  const [activeGenre, setActiveGenre]   = useState<string | null>(null);
  const windowStartRef = useRef(0);

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
      if (ahead?.sample_movie_url) {
        prefetchVideo(ahead.sample_movie_url, controller.signal);
      }
    }
  }, []);

  const fetchMore = useCallback(async (
    overrideCursor?: string,
    overrideSeed?: number,
    genre?: string | null,
  ) => {
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

      const currentGenre = genre !== undefined ? genre : activeGenre;
      const res = await getFeed(
        parseInt(cursor, 10),
        20,
        seed,
        currentGenre ?? undefined,
      );

      if (overrideCursor === "0") {
        allItemsRef.current   = res.items;
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
  }, [updateWindow, activeGenre]);

  // タグ選択時にフィードをリセット
  const handleGenreSelect = useCallback((genre: string | null) => {
    setActiveGenre(genre);
    allItemsRef.current   = [];
    nextCursorRef.current = null;
    currentIdxRef.current = 0;
    setCurrentIndex(0);
    setWindowItems([]);

    const seed = resetSeed();
    seedRef.current = seed;
    // fetchMoreはactiveGenreの更新を待たず直接genreを渡す
    isFetchingRef.current = false;

    const params = new URLSearchParams({ offset: "0", limit: "20", seed: String(seed) });
    if (genre) params.set("genre", genre);
    const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000";
    fetch(`${API_BASE_URL}/api/v1/feed?${params}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((res) => {
        allItemsRef.current   = res.items;
        nextCursorRef.current = res.next_cursor;
        updateWindow(0);
      })
      .catch(console.error);
  }, [updateWindow]);

  useEffect(() => {
    const seed = getOrCreateSeed();
    seedRef.current = seed;
    fetchMore("0", seed, null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goNext = useCallback(() => {
    const all  = allItemsRef.current;
    const next = currentIdxRef.current + 1;

    if (all.length - next <= PREFETCH_AHEAD) fetchMore();
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

    const onTouchStart = (e: TouchEvent) => { startY = e.touches[0].clientY; startTime = Date.now(); };
    const onTouchEnd   = (e: TouchEvent) => {
      const dy = startY - e.changedTouches[0].clientY;
      const dt = Date.now() - startTime;
      if (Math.abs(dy) > 40 && dt < 500) { if (dy > 0) goNext(); else goPrev(); }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (wheelLockRef.current) return;
      wheelLockRef.current = true;
      setTimeout(() => { wheelLockRef.current = false; }, 300);
      if (e.deltaY > 0) goNext(); else goPrev();
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

  useEffect(() => {
    if (windowItems.length === 0 && !isFetchingRef.current) fetchMore();
  }, [windowItems, fetchMore]);

  return (
    <>
      {/* タグバー */}
      <div className="genre-bar">
        <button
          className={`genre-chip${activeGenre === null ? " active" : ""}`}
          onClick={() => handleGenreSelect(null)}
        >
          オール
        </button>
        {GENRE_TAGS.map((tag) => (
          <button
            key={tag}
            className={`genre-chip${activeGenre === tag ? " active" : ""}`}
            onClick={() => handleGenreSelect(tag)}
          >
            {tag}
          </button>
        ))}
      </div>

      <div ref={containerRef} className="feed-container">
        {windowItems.length === 0 ? (
          <div className="feed-loading">
            <div className="feed-spinner" />
          </div>
        ) : (
          windowItems.map((item, i) => {
            const absIndex = windowStartRef.current + i;
            const offset   = absIndex - currentIndex;
            const isActive = offset === 0;
            return (
              <div
                key={`${item.id}-${absIndex}`}
                className="feed-slide"
                style={{
                  transform:     `translateY(${offset * 100}%)`,
                  zIndex:        isActive ? 2 : 1,
                  pointerEvents: isActive ? "auto" : "none",
                  visibility:    isActive ? "visible" : "hidden",
                }}
              >
                <FeedItem item={item} isFirst={absIndex === 0} isSecond={absIndex === 1} />
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
  .genre-bar {
    position: fixed;
    top: 52px;
    left: 0; right: 0;
    z-index: 100;
    display: flex;
    gap: 8px;
    padding: 8px 12px;
    overflow-x: auto;
    background: linear-gradient(to bottom, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0) 100%);
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .genre-bar::-webkit-scrollbar { display: none; }
  .genre-chip {
    flex-shrink: 0;
    padding: 5px 14px;
    border-radius: 999px;
    border: 1px solid rgba(255,255,255,0.3);
    background: rgba(255,255,255,0.1);
    color: rgba(255,255,255,0.75);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    -webkit-tap-highlight-color: transparent;
  }
  .genre-chip.active {
    background: #e91e63;
    border-color: #e91e63;
    color: #fff;
  }
`;
