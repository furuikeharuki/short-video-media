"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import FeedViewer from "@/components/FeedViewer";
import { markSeen, getOrCreateSeed } from "@/lib/feedOrder";
import { getFeed } from "@/lib/api/feed";
import { getMovieBySlug } from "@/lib/api/movies";
import { loadPlaylist, clearPlaylist } from "@/lib/feedPlaylist";
import { logEvent } from "@/lib/api/events";
import type { MovieCard } from "@/lib/api/feed";
import type { MovieDetail } from "@/lib/api/movies";

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

function isPageReload(): boolean {
  try {
    const entries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    if (entries.length > 0) return entries[0].type === "reload";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (performance as any).navigation?.type === 1;
  } catch { return false; }
}

function movieDetailToCard(m: MovieDetail): MovieCard {
  return {
    id: m.id,
    content_id: m.content_id,
    title: m.title,
    slug: m.slug,
    image_url_list: m.image_url_list,
    image_url_large: m.image_url_large,
    sample_movie_url: m.sample_movie_url,
    affiliate_url: m.affiliate_url,
    price_list: m.price_list,
    price_min: m.price_min,
    review_count: m.review_count,
    review_average: m.review_average,
    actresses: m.actresses,
    genres: m.genres,
    series_name: m.series_name,
  };
}

export default function FeedClient() {
  const searchParams  = useSearchParams();
  const seedRef       = useRef<number | null>(null);
  const isFetchingRef = useRef(false);
  const nextCursorRef = useRef<string | null>(null);

  const [items,        setItems]        = useState<MovieCard[]>([]);
  const [initialIndex, setInitialIndex] = useState(0);
  const [isEmpty,      setIsEmpty]      = useState(false);
  const [isLoading,    setIsLoading]    = useState(true);

  const fetchInitial = useCallback(async (seed: number, startIndex = 0, prependSlug?: string) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      const [res, pinnedMovie] = await Promise.all([
        getFeed(0, 20, seed),
        prependSlug ? getMovieBySlug(prependSlug).catch(() => null) : Promise.resolve(null),
      ]);

      let feedItems = res.items;

      if (pinnedMovie) {
        const card = movieDetailToCard(pinnedMovie);
        // 重複排除して先頭に差し込む
        feedItems = [card, ...feedItems.filter((i) => i.slug !== card.slug)];
      }

      const idx = Math.min(startIndex, feedItems.length - 1);
      setItems(feedItems);
      setInitialIndex(idx);
      setIsEmpty(feedItems.length === 0);
      nextCursorRef.current = res.next_cursor;
      saveSession(seed, idx, feedItems);
    } catch (e) {
      console.error("fetchInitial failed", e);
    } finally {
      isFetchingRef.current = false;
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const vSlug = searchParams.get("v") ?? undefined;
    const playlistKey = searchParams.get("playlist") ?? undefined;

    // ?playlist=<key> がある場合は sessionStorage に保存されたリストをそのまま使う
    // (API を叩かず、セクションの順番をそのまま再現する)
    if (playlistKey) {
      const pl = loadPlaylist(playlistKey);
      if (pl && pl.items.length > 0) {
        const seed = getOrCreateSeed();
        seedRef.current = seed;
        const idx = Math.min(Math.max(pl.startIndex, 0), pl.items.length - 1);
        setItems(pl.items);
        setInitialIndex(idx);
        setIsEmpty(false);
        setIsLoading(false);
        nextCursorRef.current = null;
        saveSession(seed, idx, pl.items);
        // 遷移後は一度だけ使えればよいのでクリア
        clearPlaylist(playlistKey);
        return;
      }
      // playlist が見つからないときは通常のフィードにフォールバック
    }

    // ?v= がある場合は常に新鮮なフィードを取得（先頭に該当動画を差し込む）
    if (vSlug) {
      const seed = getOrCreateSeed();
      seedRef.current = seed;
      fetchInitial(seed, 0, vSlug);
      return;
    }

    if (isPageReload()) {
      try {
        sessionStorage.removeItem(FEED_SEED_KEY);
        sessionStorage.removeItem(FEED_INDEX_KEY);
        sessionStorage.removeItem(FEED_ITEMS_KEY);
      } catch { /* ignore */ }
      const seed = getOrCreateSeed();
      seedRef.current = seed;
      fetchInitial(seed, 0);
      return;
    }

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
    const cur = items[index];
    if (cur) {
      markSeen(cur.id);
      // ランキング集計のために view イベントを記録
      logEvent({ event_type: "view", slug: cur.slug, title: cur.title });
    }
    try { sessionStorage.setItem(FEED_INDEX_KEY, String(index)); } catch { /* ignore */ }
  }, [items]);

  const firstViewLoggedRef = useRef(false);
  useEffect(() => {
    if (isLoading) return;
    if (firstViewLoggedRef.current) return;
    const cur = items[initialIndex];
    if (!cur) return;
    firstViewLoggedRef.current = true;
    markSeen(cur.id);
    logEvent({ event_type: "view", slug: cur.slug, title: cur.title });
  }, [isLoading, items, initialIndex]);

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
