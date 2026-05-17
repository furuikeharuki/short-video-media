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
 * セクションの「もっと見る」先。
 * SSR で初期 20 件を受け取り、画面下に来たら /api/v1/home/section で次の 20 件を取りにいく。
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
  const fetchingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const fetchMore = useCallback(async () => {
    if (fetchingRef.current) return;
    if (!nextCursor) return;
    const offset = parseInt(nextCursor, 10);
    if (Number.isNaN(offset)) return;
    fetchingRef.current = true;
    try {
      const res = await getHomeSection(sectionKey, offset, 20);
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
      {/* 次ページ取得用 sentinel */}
      <div ref={sentinelRef} className="list-sentinel" aria-hidden="true" />
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
  .list-sentinel { height: 1px; }
  .list-footer-spacer { height: 24px; }
`;
