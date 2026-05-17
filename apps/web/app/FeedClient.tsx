"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import FeedViewer from "@/components/FeedViewer";
import { markSeen, getOrCreateSeed } from "@/lib/feedOrder";
import { getFeed } from "@/lib/api/feed";
import { getMovieBySlug } from "@/lib/api/movies";
import { loadPlaylist, clearPlaylist } from "@/lib/feedPlaylist";
import { logEvent } from "@/lib/api/events";
import { recordView } from "@/lib/api/me";
import type { MovieCard } from "@/lib/api/feed";
import type { MovieDetail } from "@/lib/api/movies";

const FEED_SEED_KEY   = "feed_seed";
const FEED_INDEX_KEY  = "feed_index";
const FEED_ITEMS_KEY  = "feed_items";
const FEED_CURSOR_KEY = "feed_next_cursor";

function saveSession(seed: number, index: number, items: object[], nextCursor: string | null) {
  try {
    sessionStorage.setItem(FEED_SEED_KEY,  String(seed));
    sessionStorage.setItem(FEED_INDEX_KEY, String(index));
    sessionStorage.setItem(FEED_ITEMS_KEY, JSON.stringify(items));
    if (nextCursor !== null) sessionStorage.setItem(FEED_CURSOR_KEY, nextCursor);
    else                     sessionStorage.removeItem(FEED_CURSOR_KEY);
  } catch { /* ignore */ }
}

function loadSession(): { seed: number; index: number; items: object[]; nextCursor: string | null } | null {
  try {
    const seed  = sessionStorage.getItem(FEED_SEED_KEY);
    const index = sessionStorage.getItem(FEED_INDEX_KEY);
    const items = sessionStorage.getItem(FEED_ITEMS_KEY);
    if (!seed || !index || !items) return null;
    return {
      seed:  parseInt(seed, 10),
      index: parseInt(index, 10),
      items: JSON.parse(items),
      nextCursor: sessionStorage.getItem(FEED_CURSOR_KEY),
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
  const { status: authStatus } = useSession();
  const seedRef       = useRef<number | null>(null);
  const isFetchingRef = useRef(false);
  const isFetchingMoreRef = useRef(false);
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
      saveSession(seed, idx, feedItems, res.next_cursor);
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
        saveSession(seed, idx, pl.items, null);
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
        sessionStorage.removeItem(FEED_CURSOR_KEY);
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
      nextCursorRef.current = session.nextCursor;
    } else {
      const seed = getOrCreateSeed();
      seedRef.current = seed;
      fetchInitial(seed, 0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 追加ページを取得して items に append する。
  // FeedViewer は残り 5 件以下になったとき onNearEnd を引いてくるので、
  // ここで next_cursor を offset に訳して逆引して、重複除去のうえで末尾に足す。
  // playlist 経由や、API が next_cursor=null を返した (末尾到達) ときは何もしない。
  const fetchMore = useCallback(async () => {
    if (isFetchingMoreRef.current) return;
    const cursor = nextCursorRef.current;
    const seed   = seedRef.current;
    if (!cursor || seed === null) return;
    const offset = parseInt(cursor, 10);
    if (Number.isNaN(offset)) return;

    isFetchingMoreRef.current = true;
    try {
      const res = await getFeed(offset, 20, seed);
      nextCursorRef.current = res.next_cursor;
      if (res.items.length === 0) return;
      setItems((prev) => {
        const existing = new Set(prev.map((i) => i.id));
        const fresh    = res.items.filter((i) => !existing.has(i.id));
        if (fresh.length === 0) return prev;
        const merged = [...prev, ...fresh];
        // セッションの items も更新して、モーダル」戻り時にも返せるようにする。
        // index は handleIndexChange で随時保存されているのでここでは触らず、
        // 現在保存されている値をそのまま使う。
        try {
          const savedIdx = sessionStorage.getItem(FEED_INDEX_KEY);
          saveSession(seed, savedIdx ? parseInt(savedIdx, 10) : 0, merged, nextCursorRef.current);
        } catch { /* ignore */ }
        return merged;
      });
    } catch (e) {
      console.error("fetchMore failed", e);
    } finally {
      isFetchingMoreRef.current = false;
    }
  }, []);

  // FeedViewer から "残りわずか" になったときに呼ばれる。ただし同一位置で連発しないように
  // useCallback でラップして、中で fetchMore を一回だけ走らせる。
  const handleNearEnd = useCallback(() => {
    void fetchMore();
  }, [fetchMore]);

  const handleIndexChange = useCallback((index: number) => {
    const cur = items[index];
    if (cur) {
      markSeen(cur.id);
      // ランキング集計のために view イベントを記録 (サーバ側で集計、認証不要)
      logEvent({ event_type: "view", slug: cur.slug, title: cur.title });
      // ログイン中のみ視聴履歴に記録 (未ログインだと 401 になるのでスキップ)
      if (authStatus === "authenticated") {
        void recordView(cur.id);
      }
    }
    try { sessionStorage.setItem(FEED_INDEX_KEY, String(index)); } catch { /* ignore */ }
  }, [items, authStatus]);

  const firstViewLoggedRef = useRef(false);
  useEffect(() => {
    if (isLoading) return;
    if (firstViewLoggedRef.current) return;
    const cur = items[initialIndex];
    if (!cur) return;
    firstViewLoggedRef.current = true;
    markSeen(cur.id);
    logEvent({ event_type: "view", slug: cur.slug, title: cur.title });
    if (authStatus === "authenticated") {
      void recordView(cur.id);
    }
  }, [isLoading, items, initialIndex, authStatus]);

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
        onNearEnd={handleNearEnd}
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
