"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MovieCardThumb from "@/components/home/MovieCardThumb";
import type { MovieCard } from "@/lib/api/feed";
import { getHomeSection, type HomeSectionKey } from "@/lib/api/homeSection";

type Props = {
  sectionKey: Exclude<HomeSectionKey, "genre">;
  title: string;
  /** 順位バッジを出すか (人気・ランキング系) */
  ranked: boolean;
  initialItems: MovieCard[];
  initialNextCursor: string | null;
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

/** 表示列数に応じた次ページの取得件数。
 *  列数の倍数になるように選んで、連続スクロールしたときに行の末端が半端にならないようにする。
 *  3 列 → 21 (7 行)、5 列 → 20 (4 行)、7 列 → 21 (3 行)。 */
function batchSize(columns: number): number {
  if (columns === 3) return 21; // 7 行
  if (columns === 5) return 20; // 4 行
  return 21; // 7 列で 3 行
}

/**
 * セクションの「もっと見る」先。
 * SSR で初期 20 件を受け取り、画面下に来たら /api/v1/home/section で次の 1 バッチを取りにいく。
 * バッチサイズは現在の表示列数の倍数 (3/5/7 列いずれでも半端が出ない件数) に揃える。
 * カードをタップすると同じ並びで /feed に遷移する (MovieCardThumb の playlist 機構)。
 */
export default function ListClient({
  sectionKey,
  title,
  ranked,
  initialItems,
  initialNextCursor,
}: Props) {
  const [items, setItems] = useState<MovieCard[]>(initialItems);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const fetchingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const fetchMore = useCallback(async () => {
    if (fetchingRef.current) return;
    if (!nextCursor) return;
    const offset = parseInt(nextCursor, 10);
    if (Number.isNaN(offset)) return;
    fetchingRef.current = true;
    setIsLoadingMore(true);
    try {
      const cols =
        typeof window !== "undefined" ? columnsForWidth(window.innerWidth) : 3;
      const limit = batchSize(cols);
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

  if (items.length === 0) {
    return (
      <main className="list-main">
        <p className="list-empty">該当する作品が見つかりませんでした</p>
        <style>{pageCSS}</style>
      </main>
    );
  }

  return (
    <main className="list-main">
      <div className="list-meta">
        <h1 className="list-title">{title}</h1>
      </div>
      <div className="list-grid">
        {items.map((item, index) => (
          <MovieCardThumb
            key={item.id}
            movie={item}
            aspect="portrait"
            fluid
            rank={ranked ? index + 1 : undefined}
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
  .list-meta {
    padding: 12px 16px 4px;
  }
  .list-title {
    margin: 0;
    font-size: 17px;
    font-weight: 800;
    color: #fff;
    letter-spacing: -0.01em;
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
