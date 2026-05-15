"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FeedViewer from "@/components/FeedViewer";
import { markSeen, getOrCreateSeed } from "@/lib/feedOrder";
import { getFeed } from "@/lib/api/feed";
import type { MovieCard } from "@/lib/api/feed";

const FEED_SEED_KEY  = "feed_seed";
const FEED_INDEX_KEY = "feed_index";
const FEED_ITEMS_KEY = "feed_items";

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
  } catch { return null; }
}

export default function FeedClient() {
  const seedRef       = useRef<number | null>(null);
  const isFetchingRef = useRef(false);
  const nextCursorRef = useRef<string | null>(null);

  const [items,       setItems]       = useState<MovieCard[]>([]);
  const [initialIndex, setInitialIndex] = useState(0);
  const [isEmpty,     setIsEmpty]     = useState(false);
  const [isLoading,   setIsLoading]   = useState(true);

  const fetchInitial = useCallback(async (seed: number, startIndex = 0) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      const res = await getFeed(0, 20, seed);
      const idx = Math.min(startIndex, res.items.length - 1);
      setItems(res.items);
      setInitialIndex(idx);
      setIsEmpty(res.items.length === 0);
      nextCursorRef.current = res.next_cursor;
      saveSession(seed, idx, res.items);
    } catch (e) {
      console.error("fetchInitial failed", e);
    } finally {
      isFetchingRef.current = false;
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const session = loadSession();
    if (session && session.items.length > 0) {
      seedRef.current = session.seed;
      const idx = Math.min(session.index, (session.items as MovieCard[]).length - 1);
      setItems(session.items as MovieCard[]);
      setInitialIndex(idx);
      setIsEmpty(false);
      setIsLoading(false);
    } else {
      const seed = getOrCreateSeed();
      seedRef.current = seed;
      fetchInitial(seed, 0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleIndexChange = useCallback((index: number) => {
    if (items[index]) markSeen(items[index].id);
    try { sessionStorage.setItem(FEED_INDEX_KEY, String(index)); } catch { /* ignore */ }
  }, [items]);

  if (isEmpty) {
    return (
      <div className="feed-empty">
        <p className="feed-empty-text">該当する作品が見つかりませんでした</p>
      </div>
    );
  }

  if (isLoading || items.length === 0) {
    return (
      <div className="feed-loading">
        <div className="feed-spinner" />
      </div>
    );
  }

  return (
    <>
      <FeedViewer
        items={items}
        initialIndex={initialIndex}
        onIndexChange={handleIndexChange}
      />
      <style>{uiStyle}</style>
    </>
  );
}

const uiStyle = `
  .feed-loading {
    position: fixed; inset: 0;
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
    position: fixed; inset: 0;
    display: flex; align-items: center; justify-content: center;
    background: #000;
  }
  .feed-empty-text {
    font-size: 15px;
    color: rgba(255,255,255,0.5);
  }
`;
