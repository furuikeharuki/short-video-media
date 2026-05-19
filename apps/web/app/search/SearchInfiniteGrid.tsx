"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import MovieCardThumb from "@/components/home/MovieCardThumb";
import AdSlot from "@/components/ads/AdSlot";
import { AD_FEED_INTERVAL, isAdZoneEnabled } from "@/lib/ads/config";
import type { MovieCard } from "@/lib/api/feed";
import { getFeed } from "@/lib/api/feed";
import {
  searchMovies,
  searchMoviesByExactField,
  advancedSearch,
  type ExactField,
  type AdvancedSearchInput,
} from "@/lib/api/search";
import { useSavedFilterStatus } from "@/components/SavedFilterContext";

type SourceKeyword = { kind: "keyword"; query: string };
type SourceExact = { kind: "exact"; field: ExactField; value: string };
type SourceGenre = { kind: "genre"; genre: string };
type SourceAdvanced = { kind: "advanced"; input: AdvancedSearchInput };
type Source = SourceKeyword | SourceExact | SourceGenre | SourceAdvanced;

type Props = {
  source: Source;
  playlistKey: string;
  playlistTitle: string;
  headingPrefix: string;
  headerSlot?: React.ReactNode;
};

function columnsForWidth(w: number): number {
  if (w >= 1024) return 7;
  if (w >= 640) return 5;
  return 3;
}

function batchSize(columns: number): number {
  if (columns === 3) return 21;
  if (columns === 5) return 20;
  return 21;
}

type Page = {
  items: MovieCard[];
  nextOffset: number | null;
};

async function fetchPage(
  source: Source,
  offset: number,
  limit: number,
): Promise<Page> {
  if (source.kind === "keyword") {
    const res = await searchMovies(source.query, offset, limit);
    return {
      items: res.items,
      nextOffset: res.next_cursor !== null ? parseInt(res.next_cursor, 10) : null,
    };
  }
  if (source.kind === "exact") {
    const res = await searchMoviesByExactField(
      source.field,
      source.value,
      offset,
      limit,
    );
    return {
      items: res.items,
      nextOffset: res.next_cursor !== null ? parseInt(res.next_cursor, 10) : null,
    };
  }
  if (source.kind === "genre") {
    const res = await getFeed(offset, limit, undefined, [source.genre]);
    const nextOffset =
      res.next_cursor !== null ? parseInt(res.next_cursor, 10) : null;
    return {
      items: res.items,
      nextOffset: Number.isNaN(nextOffset as number) ? null : nextOffset,
    };
  }
  const res = await advancedSearch(source.input, offset, limit);
  return {
    items: res.items,
    nextOffset: res.next_cursor !== null ? parseInt(res.next_cursor, 10) : null,
  };
}

/**
 * フィード内に差し込むネイティブ広告カード。
 * feedNative ゾーン（zoneid: 5930078）专用。
 * グリッド内に grid-column: 1/-1 で全幅展開。
 */
function FeedNativeAd({ adIndex }: { adIndex: number }) {
  if (!isAdZoneEnabled("feedNative")) return null;
  return (
    <div className="search-grid-ad">
      <AdSlot
        zone="feedNative"
        context={`feed-${adIndex}`}
        label="広告"
      />
    </div>
  );
}

export default function SearchInfiniteGrid({
  source,
  playlistKey,
  playlistTitle,
  headingPrefix,
  headerSlot,
}: Props) {
  const enforceStatus = useSavedFilterStatus();
  const [items, setItems] = useState<MovieCard[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const fetchingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const columnsRef = useRef<number | null>(null);

  const sourceKey = JSON.stringify(source);

  const fetchMore = useCallback(async () => {
    if (fetchingRef.current) return;
    if (columnsRef.current === null) return;
    if (nextOffset === null) return;
    fetchingRef.current = true;
    setIsLoadingMore(true);
    try {
      const limit = batchSize(columnsRef.current);
      const page = await fetchPage(source, nextOffset, limit);
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        const fresh = page.items.filter((i) => !seen.has(i.id));
        return fresh.length === 0 ? prev : [...prev, ...fresh];
      });
      setNextOffset(page.nextOffset);
    } catch (e) {
      console.error("search fetchMore failed", e);
    } finally {
      fetchingRef.current = false;
      setIsLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, nextOffset]);

  useEffect(() => {
    if (enforceStatus === "pending") {
      setIsInitialLoading(true);
      return;
    }
    let cancelled = false;
    setItems([]);
    setNextOffset(0);
    setIsInitialLoading(true);
    (async () => {
      columnsRef.current = columnsForWidth(window.innerWidth);
      const limit = batchSize(columnsRef.current);
      try {
        const page = await fetchPage(source, 0, limit);
        if (cancelled) return;
        setItems(page.items);
        setNextOffset(page.nextOffset);
      } catch (e) {
        console.error("search initial load failed", e);
      } finally {
        if (!cancelled) setIsInitialLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, enforceStatus]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void fetchMore();
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [fetchMore]);

  if (enforceStatus === "pending" || isInitialLoading) {
    return (
      <main className="search-main">
        {headerSlot ?? <p className="search-meta">{headingPrefix}</p>}
        <div className="search-initial-loading" role="status" aria-live="polite">
          <span className="search-spinner" aria-hidden="true" />
          <span className="search-load-label">読み込み中…</span>
        </div>
        <style>{pageCSS}</style>
      </main>
    );
  }

  if (items.length === 0) {
    return (
      <main className="search-main">
        {headerSlot ?? <p className="search-meta">{headingPrefix}</p>}
        <p className="search-empty">該当する作品が見つかりませんでした</p>
        <style>{pageCSS}</style>
      </main>
    );
  }

  const feedInterval = AD_FEED_INTERVAL; // デフォルト 10、envで上書き可
  const feedEnabled = isAdZoneEnabled("feedNative") && feedInterval > 0;
  let adIndex = 0; // context 区別用カウンター

  return (
    <main className="search-main">
      {headerSlot ?? <p className="search-meta">{headingPrefix}</p>}
      <div className="search-grid">
        {items.map((item, index) => {
          // index > 0 かつ feedInterval の倍数のときに広告を振る
          const showAdBefore =
            feedEnabled && index > 0 && index % feedInterval === 0;
          const currentAdIndex = showAdBefore ? adIndex++ : adIndex;

          return (
            <Fragment key={item.id}>
              {showAdBefore && <FeedNativeAd adIndex={currentAdIndex} />}
              <MovieCardThumb
                movie={item}
                aspect="portrait"
                fluid
                playlist={{
                  key: `${playlistKey}-${item.id}`,
                  title: playlistTitle,
                  startIndex: index,
                  items,
                }}
              />
            </Fragment>
          );
        })}
      </div>
      {nextOffset !== null && (
        <div
          ref={sentinelRef}
          className="search-load-more"
          role="status"
          aria-live="polite"
        >
          <span className="search-spinner" aria-hidden="true" />
          <span className="search-load-label">
            {isLoadingMore ? "読み込み中…" : "さらに読み込みます"}
          </span>
        </div>
      )}
      <div className="search-footer-spacer" />
      <style>{pageCSS}</style>
    </main>
  );
}

const pageCSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #0a0a0a !important; overflow: hidden !important; }
  .search-main {
    position: fixed;
    top: 52px;
    left: 0; right: 0;
    bottom: var(--bottom-nav-h, 56px);
    overflow-y: auto;
    overflow-x: hidden;
    -webkit-overflow-scrolling: touch;
    background: #0a0a0a;
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  .search-meta {
    font-size: 12px;
    color: rgba(255,255,255,0.45);
    padding: 12px 16px 4px;
  }
  .search-empty {
    text-align: center;
    color: rgba(255,255,255,0.4);
    font-size: 14px;
    margin-top: 80px;
  }
  .search-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    padding: 8px;
  }
  .search-grid > .mct { width: 100%; min-width: 0; }

  /* 広告コンテナ: グリッド内全幅で占有 */
  .search-grid-ad {
    grid-column: 1 / -1;
    width: 100%;
    max-width: 100%;
    overflow: hidden;
    box-sizing: border-box;
    padding: 4px 0;
  }
  .search-grid-ad .ad-slot {
    width: 100% !important;
    max-width: 100% !important;
  }
  .search-grid-ad .ad-slot ins,
  .search-grid-ad .ad-slot iframe,
  .search-grid-ad .ad-slot img {
    max-width: 100% !important;
    box-sizing: border-box !important;
  }

  @media (min-width: 640px) {
    .search-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  }
  @media (min-width: 1024px) {
    .search-grid {
      grid-template-columns: repeat(7, minmax(0, 1fr));
      max-width: 1200px;
      margin: 0 auto;
    }
  }
  .search-grid a:hover img { transform: scale(1.04); }
  .search-load-more,
  .search-initial-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 20px 16px;
    color: rgba(255,255,255,0.6);
    font-size: 13px;
    min-height: 48px;
  }
  .search-initial-loading { padding: 80px 16px; }
  .search-spinner {
    width: 18px; height: 18px;
    border: 2px solid rgba(255,255,255,0.18);
    border-top-color: #fff;
    border-radius: 50%;
    animation: search-spin 0.8s linear infinite;
  }
  @keyframes search-spin { to { transform: rotate(360deg); } }
  .search-load-label { line-height: 1; }
  .search-footer-spacer { height: 24px; }
`;
