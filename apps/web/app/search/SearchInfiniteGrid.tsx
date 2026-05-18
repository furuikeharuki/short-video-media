"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MovieCardThumb from "@/components/home/MovieCardThumb";
import type { MovieCard } from "@/lib/api/feed";
import { getFeed } from "@/lib/api/feed";
import {
  searchMovies,
  searchMoviesByExactField,
  type ExactField,
} from "@/lib/api/search";

/**
 * 検索結果ページ用の無限スクロールグリッド。
 *
 * 検索クエリの種類 (キーワード / 完全一致フィールド / ジャンル) に応じて
 * 適切な API を offset+limit でページングして呼び出し、ホーム画面のセクション
 * もっと見る画面 (ListClient) と同じく IntersectionObserver で順次読み足す。
 */

type SourceKeyword = { kind: "keyword"; query: string };
type SourceExact = { kind: "exact"; field: ExactField; value: string };
type SourceGenre = { kind: "genre"; genre: string };
type Source = SourceKeyword | SourceExact | SourceGenre;

type Props = {
  source: Source;
  /** プレイリストのキー前綴 (検索の種類で一意になる)。 */
  playlistKey: string;
  /** プレイリストの UI 表示用タイトル。 */
  playlistTitle: string;
  /** 検索条件のラベル (例: 「監督「苺原」の作品」「#プロ女優 の動画」)。 */
  headingPrefix: string;
};

/** 画面幅に応じた列数 (search-grid の CSS と一致)。 */
function columnsForWidth(w: number): number {
  if (w >= 1024) return 7;
  if (w >= 640) return 5;
  return 3;
}

/** 列の倍数で揃える 1 ページあたりの件数。 */
function batchSize(columns: number): number {
  if (columns === 3) return 21;
  if (columns === 5) return 20;
  return 21;
}

type Page = {
  items: MovieCard[];
  /** 次ページの offset (null なら末尾)。 */
  nextOffset: number | null;
};

/** ソース種別に応じて 1 ページ取得する。 */
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
  // genre
  const res = await getFeed(offset, limit, undefined, [source.genre]);
  const nextOffset =
    res.next_cursor !== null ? parseInt(res.next_cursor, 10) : null;
  return {
    items: res.items,
    nextOffset: Number.isNaN(nextOffset as number) ? null : nextOffset,
  };
}

export default function SearchInfiniteGrid({
  source,
  playlistKey,
  playlistTitle,
  headingPrefix,
}: Props) {
  const [items, setItems] = useState<MovieCard[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const fetchingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // 列数は初期マウント時に 1 回だけ確定させる
  // (ブレイクポイント跨ぎで途中から取得件数が混在するとグリッドが崩れる)
  const columnsRef = useRef<number | null>(null);

  // ソースが変わったら state をリセットする
  // (検索ページ自体は遷移ごとに別マウントになるはずだが念のため)
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

  // 初回マウント: 列数を確定して 1 ページ目を取る。
  useEffect(() => {
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
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  // 末尾の sentinel が見えたら次を取る。
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void fetchMore();
        }
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [fetchMore]);

  if (isInitialLoading) {
    return (
      <main className="search-main">
        <p className="search-meta">{headingPrefix}</p>
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
        <p className="search-meta">{headingPrefix}</p>
        <p className="search-empty">該当する作品が見つかりませんでした</p>
        <style>{pageCSS}</style>
      </main>
    );
  }

  return (
    <main className="search-main">
      <p className="search-meta">{headingPrefix}</p>
      <div className="search-grid">
        {items.map((item, index) => (
          <MovieCardThumb
            key={item.id}
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
        ))}
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
