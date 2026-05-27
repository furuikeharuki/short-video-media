"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import SimpleBackButton from "@/components/SimpleBackButton";
import AdSlot from "@/components/ads/AdSlot";
import { AD_LIST_INTERVAL, isAdZoneEnabled } from "@/lib/ads/config";
import type { ActressCard } from "@/lib/api/home";
import { getPopularActressesSection } from "@/lib/api/homeSection";

type Props = {
  title: string;
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

/**
 * 人気女優 (Actress) 一覧ページ用クライアント。
 * 動画/商品と違いカードは正方形サムネ + 名前のみで、リンクは女優詳細ページ
 * (/actresses/[name]) に飛ばす。
 */
export default function ActressListClient({ title }: Props) {
  const [items, setItems] = useState<ActressCard[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const fetchingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
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
      const res = await getPopularActressesSection(offset, limit);
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        const fresh = res.items.filter((i) => !seen.has(i.id));
        return fresh.length === 0 ? prev : [...prev, ...fresh];
      });
      setNextCursor(res.next_cursor);
    } catch (e) {
      console.error("popular_actresses fetchMore failed", e);
    } finally {
      fetchingRef.current = false;
      setIsLoadingMore(false);
    }
  }, [nextCursor]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      columnsRef.current = columnsForWidth(window.innerWidth);
      const limit = batchSize(columnsRef.current);
      try {
        const res = await getPopularActressesSection(0, limit);
        if (cancelled) return;
        setItems(res.items);
        setNextCursor(res.next_cursor);
      } catch (e) {
        console.error("popular_actresses initial load failed", e);
      } finally {
        if (!cancelled) setIsInitialLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
        <p className="list-empty">該当する女優が見つかりませんでした</p>
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
      <div className="actress-grid">
        {items.map((a, index) => {
          const showAdBefore =
            isAdZoneEnabled("mobileBanner300x250") &&
            AD_LIST_INTERVAL > 0 &&
            index > 0 &&
            index % AD_LIST_INTERVAL === 0;
          const img =
            a.image_url_large ?? a.image_url_small ?? a.thumbnail_url ?? "";
          const rank = index < 100 ? index + 1 : undefined;
          const href = `/actresses/${encodeURIComponent(a.name)}`;
          return (
            <Fragment key={a.id}>
              {showAdBefore && (
                <div className="list-grid-ad">
                  <AdSlot zone="mobileBanner300x250" />
                </div>
              )}
              <Link href={href} className="actress-card" aria-label={a.name}>
                <div className="actress-thumb">
                  {img ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img} alt={a.name} loading="lazy" />
                  ) : (
                    <div className="actress-thumb-placeholder" />
                  )}
                  {rank != null && (
                    <span
                      className={`actress-rank ${rank <= 3 ? "actress-rank--top" : ""}`}
                    >
                      {rank}
                    </span>
                  )}
                </div>
                <div className="actress-name" title={a.name}>{a.name}</div>
              </Link>
            </Fragment>
          );
        })}
      </div>
      {nextCursor && (
        <div
          ref={sentinelRef}
          className="list-load-more"
          role="status"
          aria-live="polite"
        >
          <span className="list-spinner" aria-hidden="true" />
          <span className="list-load-label">
            {isLoadingMore ? "読み込み中…" : "さらに読み込みます"}
          </span>
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
  .actress-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    padding: 8px;
  }
  .list-grid-ad {
    grid-column: 1 / -1;
    display: flex;
    justify-content: center;
    padding: 4px 0;
  }
  @media (min-width: 640px) {
    .actress-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  }
  @media (min-width: 1024px) {
    .actress-grid {
      grid-template-columns: repeat(7, minmax(0, 1fr));
      max-width: 1200px;
      margin: 0 auto;
    }
  }
  .actress-card {
    display: block;
    text-decoration: none;
    color: #fff;
    -webkit-tap-highlight-color: transparent;
    min-width: 0;
  }
  .actress-thumb {
    position: relative;
    width: 100%;
    aspect-ratio: 1 / 1;
    border-radius: 10px;
    overflow: hidden;
    background: #111;
  }
  .actress-thumb img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center center;
    background: #111;
  }
  .actress-thumb-placeholder {
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, #222, #111);
  }
  .actress-rank {
    position: absolute;
    z-index: 2;
    top: 6px; left: 6px;
    min-width: 24px; height: 24px;
    padding: 0 6px;
    display: inline-flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.7);
    color: #fff;
    font-size: 13px;
    font-weight: 800;
    border-radius: 6px;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }
  .actress-rank--top {
    background: linear-gradient(135deg, #e91e63, #ff5174);
  }
  .actress-name {
    margin-top: 6px;
    font-size: 13px;
    line-height: 1.3;
    font-weight: 600;
    color: #fff;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    word-break: break-word;
  }
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
