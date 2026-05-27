"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import SimpleBackButton from "@/components/SimpleBackButton";
import AdSlot from "@/components/ads/AdSlot";
import { AD_LIST_INTERVAL, isAdZoneEnabled } from "@/lib/ads/config";
import type { GoodsCard } from "@/lib/api/home";
import { getPopularProductsSection } from "@/lib/api/homeSection";
import { trackEvent } from "@/lib/analytics/analytics";

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
 * 人気商品 (Goods) 一覧ページ用クライアント。
 * MovieCard と異なり Goods はアフィリエイト URL に直接遷移する物販なので、
 * 動画用の playlist / feed 起動導線は持たない。
 */
export default function GoodsListClient({ title }: Props) {
  const [items, setItems] = useState<GoodsCard[]>([]);
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
      const res = await getPopularProductsSection(offset, limit);
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        const fresh = res.items.filter((i) => !seen.has(i.id));
        return fresh.length === 0 ? prev : [...prev, ...fresh];
      });
      setNextCursor(res.next_cursor);
    } catch (e) {
      console.error("popular_products fetchMore failed", e);
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
        const res = await getPopularProductsSection(0, limit);
        if (cancelled) return;
        setItems(res.items);
        setNextCursor(res.next_cursor);
      } catch (e) {
        console.error("popular_products initial load failed", e);
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
        <p className="list-empty">該当する商品が見つかりませんでした</p>
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
      <div className="goods-grid">
        {items.map((g, index) => {
          const showAdBefore =
            isAdZoneEnabled("mobileBanner300x250") &&
            AD_LIST_INTERVAL > 0 &&
            index > 0 &&
            index % AD_LIST_INTERVAL === 0;
          const img = g.image_url_large ?? g.image_url_list ?? "";
          const safeHref =
            typeof g.affiliate_url === "string" ? g.affiliate_url.trim() : "";
          const handleClick = () => {
            if (!safeHref) return;
            void trackEvent("affiliate_click", {
              slug: g.slug,
              title: g.title,
              affiliate_url: safeHref,
            });
          };
          return (
            <Fragment key={g.id}>
              {showAdBefore && (
                <div className="list-grid-ad">
                  <AdSlot zone="mobileBanner300x250" />
                </div>
              )}
              {safeHref ? (
                <a
                  href={safeHref}
                  target="_blank"
                  rel="noopener noreferrer sponsored"
                  onClick={handleClick}
                  className="goods-card"
                  title={g.title}
                >
                  <div className="goods-thumb">
                    {img ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={img} alt={g.title} loading="lazy" />
                    ) : (
                      <div className="goods-thumb-placeholder">No Image</div>
                    )}
                  </div>
                  <div className="goods-title">{g.title}</div>
                  {g.price_min != null && (
                    <div className="goods-price">
                      ¥{g.price_min.toLocaleString()}
                    </div>
                  )}
                </a>
              ) : (
                <div className="goods-card goods-card--disabled" title={g.title}>
                  <div className="goods-thumb">
                    {img ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={img} alt={g.title} loading="lazy" />
                    ) : (
                      <div className="goods-thumb-placeholder">No Image</div>
                    )}
                  </div>
                  <div className="goods-title">{g.title}</div>
                </div>
              )}
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
  .goods-grid {
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
    .goods-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  }
  @media (min-width: 1024px) {
    .goods-grid {
      grid-template-columns: repeat(7, minmax(0, 1fr));
      max-width: 1200px;
      margin: 0 auto;
    }
  }
  .goods-card {
    display: block;
    text-decoration: none;
    color: #fff;
    -webkit-tap-highlight-color: transparent;
    min-width: 0;
  }
  .goods-card--disabled { opacity: 0.5; cursor: default; }
  .goods-thumb {
    position: relative;
    width: 100%;
    aspect-ratio: 9 / 13;
    border-radius: 10px;
    overflow: hidden;
    background: #111;
  }
  .goods-thumb img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #111;
  }
  .goods-thumb-placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #1a1a1a, #2a2a2a);
    color: rgba(255,255,255,0.4);
    font-size: 12px;
  }
  .goods-title {
    margin-top: 6px;
    font-size: 12px;
    font-weight: 600;
    line-height: 1.35;
    color: #fff;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    word-break: break-word;
  }
  .goods-price {
    margin-top: 4px;
    font-size: 12px;
    font-weight: 700;
    color: #ff9d3f;
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
