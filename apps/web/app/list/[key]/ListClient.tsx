"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MovieCardThumb from "@/components/home/MovieCardThumb";
import SimpleBackButton from "@/components/SimpleBackButton";
import type { MovieCard } from "@/lib/api/feed";
import { getHomeSection, type HomeSectionKey } from "@/lib/api/homeSection";

type Props = {
  sectionKey: Exclude<HomeSectionKey, "genre">;
  title: string;
  /** 順位バッジを出すか (人気・ランキング系) */
  ranked: boolean;
};

/**
 * 画面幅に応じた表示列数。CSS の grid-template-columns と必ず一致させること。
 * (search-grid と同じブレイクポイント)
 *   default     : 3 列
 *   >= 640px    : 5 列
 *   >= 1024px   : 7 列
 */
function columnsForWidth(w: number): number {
  if (w >= 1024) return 7;
  if (w >= 640) return 5;
  return 3;
}

/** 表示列数に応じたバッチ件数。列数の倍数 (= 行末が必ず揃う) になるよう選ぶ。
 *  3 列 → 21 (7 行)、5 列 → 20 (4 行)、7 列 → 21 (3 行)。 */
function batchSize(columns: number): number {
  if (columns === 3) return 21;
  if (columns === 5) return 20;
  return 21;
}

/**
 * セクションの「もっと見る」先。
 * SSR では初期表示分を取らず、クライアントマウント時に画面幅から列数を確定してから
 * 列の倍数の件数で取りにいく。これで初期表示・追加読み込みのいずれも行末が必ず揃う。
 * カードをタップすると同じ並びで /feed に遷移する (MovieCardThumb の playlist 機構)。
 */
export default function ListClient({
  sectionKey,
  title,
  ranked,
}: Props) {
  const [items, setItems] = useState<MovieCard[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const fetchingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // 列数は初期マウント時に 1 回だけ確定させる (途中でブレイクポイントを跨いでも
  // 取得件数が混在するとグリッドの整列が崩れるため意図的に固定する)。
  const columnsRef = useRef<number | null>(null);

  const fetchMore = useCallback(async () => {
    if (fetchingRef.current) return;
    if (columnsRef.current === null) return;
    fetchingRef.current = true;
    setIsLoadingMore(true);
    try {
      const cursor = nextCursor;
      const offset = cursor === null ? 0 : parseInt(cursor, 10);
      if (Number.isNaN(offset)) return;
      const limit = batchSize(columnsRef.current);
      const res = await getHomeSection(sectionKey, offset, limit);
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        const fresh = res.items.filter((i) => !seen.has(i.id));
        return fresh.length === 0 ? prev : [...prev, ...fresh];
      });
      setNextCursor(res.next_cursor);
    } catch (e) {
      console.error("section fetchMore failed", e);
    } finally {
      fetchingRef.current = false;
      setIsLoadingMore(false);
    }
  }, [sectionKey, nextCursor]);

  // 初回マウント時: window.innerWidth から列数を確定し、その列の倍数で 1 ページ目を取得する。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      columnsRef.current = columnsForWidth(window.innerWidth);
      const limit = batchSize(columnsRef.current);
      try {
        const res = await getHomeSection(sectionKey, 0, limit);
        if (cancelled) return;
        setItems(res.items);
        setNextCursor(res.next_cursor);
      } catch (e) {
        console.error("section initial load failed", e);
      } finally {
        if (!cancelled) setIsInitialLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sectionKey]);

  // 画面末尾の sentinel が見えたら次ページを取る。
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
      <main className="list-main">
        <div className="list-subheader">
          <SimpleBackButton />
          <div className="list-subheader-title" title={title}>{title}</div>
        </div>
        <div className="list-initial-loading" role="status" aria-live="polite">
          <span className="list-spinner" aria-hidden="true" />
          <span className="list-load-label">読み込み中…</span>
        </div>
        <style>{pageCSS}</style>
      </main>
    );
  }

  if (items.length === 0) {
    return (
      <main className="list-main">
        <div className="list-subheader">
          <SimpleBackButton />
          <div className="list-subheader-title" title={title}>{title}</div>
        </div>
        <p className="list-empty">該当する作品が見つかりませんでした</p>
        <style>{pageCSS}</style>
      </main>
    );
  }

  return (
    <main className="list-main">
      <div className="list-subheader">
        <SimpleBackButton />
        <div className="list-subheader-title" title={title}>{title}</div>
      </div>
      <div className="list-grid">
        {items.map((item, index) => (
          <MovieCardThumb
            key={item.id}
            movie={item}
            aspect="portrait"
            fluid
            // ランキングセクションでも順位バッジは 100 位まで、101 件目以降はバッジなし。
            rank={ranked && index < 100 ? index + 1 : undefined}
            playlist={{
              key: `list-${sectionKey}`,
              title,
              startIndex: index,
              items,
              source: { kind: "section", key: sectionKey },
            }}
          />
        ))}
      </div>
      {/* 次ページ取得用 sentinel + ロード表示 */}
      {nextCursor && (
        <div ref={sentinelRef} className="list-load-more" role="status" aria-live="polite">
          <span className="list-spinner" aria-hidden="true" />
          <span className="list-load-label">{isLoadingMore ? "読み込み中…" : "さらに読み込みます"}</span>
        </div>
      )}
      <div className="list-footer-spacer" />
      <style>{pageCSS}</style>
    </main>
  );
}

const pageCSS = `
  html, body { background: #0a0a0a !important; overflow: hidden !important; }
  .list-main {
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
  .list-subheader {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #0a0a0a;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    min-height: 44px;
  }
  .list-subheader-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #fff;
    font-size: 14px;
    font-weight: 600;
  }
  .list-empty {
    text-align: center;
    color: rgba(255,255,255,0.4);
    font-size: 14px;
    margin-top: 80px;
  }
  .list-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    padding: 8px;
  }
  .list-grid > .mct { width: 100%; min-width: 0; }
  @media (min-width: 640px) {
    .list-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  }
  @media (min-width: 1024px) {
    .list-grid {
      grid-template-columns: repeat(7, minmax(0, 1fr));
      max-width: 1200px;
      margin: 0 auto;
    }
  }
  /* 末尾の「次を読み込み中」表示 + IntersectionObserver の sentinel を兼ねる */
  .list-load-more {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 20px 16px;
    color: rgba(255,255,255,0.6);
    font-size: 13px;
    min-height: 48px;
  }
  /* 初期表示中のフルロード表示 */
  .list-initial-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 80px 16px;
    color: rgba(255,255,255,0.6);
    font-size: 13px;
  }
  .list-spinner {
    width: 18px; height: 18px;
    border: 2px solid rgba(255,255,255,0.18);
    border-top-color: #fff;
    border-radius: 50%;
    animation: list-spin 0.8s linear infinite;
  }
  @keyframes list-spin { to { transform: rotate(360deg); } }
  .list-load-label { line-height: 1; }
  .list-footer-spacer { height: 24px; }
`;
