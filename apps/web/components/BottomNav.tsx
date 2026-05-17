"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useCallback, useState } from "react";

// ショートボタンを押して / に遷移するときに、保存されているフィードのスナップショットを破棄して
// ランダム再生を保証する。FeedClient 側は sessionStorage が空なら getFeed を新しい seed で取り直す。
function resetFeedSession() {
  try {
    sessionStorage.removeItem("feed_seed");
    sessionStorage.removeItem("feed_index");
    sessionStorage.removeItem("feed_items");
  } catch {
    /* ignore */
  }
}

const NAV_ITEMS = [
  {
    label: "ホーム",
    href: "/home",
    extraActive: [] as string[],
    iconOutline: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z"/>
        <path d="M9 21V12h6v9"/>
      </svg>
    ),
    iconFilled: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <path d="M12 2.5L2 9.2V21a1 1 0 0 0 1 1h6v-8h6v8h6a1 1 0 0 0 1-1V9.2L12 2.5z"/>
      </svg>
    ),
  },
  {
    label: "ショート",
    href: "/",
    extraActive: ["/search/feed"],
    iconOutline: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="2" width="16" height="20" rx="2"/>
        <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none"/>
      </svg>
    ),
    iconFilled: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <rect x="4" y="2" width="16" height="20" rx="2"/>
        <polygon points="10,8 16,12 10,16" fill="#000"/>
      </svg>
    ),
  },
  {
    label: "マイページ",
    href: "/mypage",
    extraActive: [] as string[],
    iconOutline: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="8" r="4"/>
        <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
      </svg>
    ),
    iconFilled: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <circle cx="12" cy="8" r="4"/>
        <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
      </svg>
    ),
  },
];

declare global {
  interface WindowEventMap {
    "video-progress": CustomEvent<{ progress: number }>;
    "video-seek": CustomEvent<{ ratio: number }>;
  }
}

export default function BottomNav() {
  const pathname    = usePathname();
  const isShortPage = pathname === "/" || pathname.startsWith("/search/feed");

  const trackRef   = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!isShortPage) return;
    const handler = (e: CustomEvent<{ progress: number }>) => {
      if (!isDragging.current) {
        setProgress(e.detail.progress);
      }
    };
    window.addEventListener("video-progress", handler);
    return () => window.removeEventListener("video-progress", handler);
  }, [isShortPage]);

  const seek = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect  = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setProgress(ratio);
    window.dispatchEvent(new CustomEvent("video-seek", { detail: { ratio } }));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isShortPage) return;
    isDragging.current = true;
    seek(e.clientX);
    const onMove = (ev: MouseEvent) => seek(ev.clientX);
    const onUp   = () => { isDragging.current = false; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [isShortPage, seek]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!isShortPage) return;
    e.stopPropagation();
    isDragging.current = true;
    seek(e.touches[0].clientX);
  }, [isShortPage, seek]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging.current) return;
    e.stopPropagation();
    seek(e.touches[0].clientX);
  }, [seek]);

  const handleTouchEnd = useCallback(() => {
    isDragging.current = false;
  }, []);

  return (
    <nav className="bottom-nav" aria-label="メインナビゲーション">

      {isShortPage && (
        <div
          ref={trackRef}
          className="seekbar-track"
          onMouseDown={handleMouseDown}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          aria-label="再生位置"
          role="slider"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <div className="seekbar-fill" style={{ width: `${progress * 100}%` }} />
          <div className="seekbar-thumb" style={{ left: `${progress * 100}%` }} />
        </div>
      )}

      {NAV_ITEMS.map((item) => {
        const isActive =
          (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)) ||
          item.extraActive.some((p) => pathname.startsWith(p));
        const icon = isActive ? item.iconFilled : item.iconOutline;

        if (isActive) {
          return (
            <span key={item.href} className="bottom-nav-item bottom-nav-item--active" aria-current="page">
              <span className="bottom-nav-icon">{icon}</span>
              <span className="bottom-nav-label">{item.label}</span>
            </span>
          );
        }
        return (
          <Link
            key={item.href}
            href={item.href}
            className="bottom-nav-item"
            onClick={
              item.href === "/"
                ? () => resetFeedSession()
                : undefined
            }
          >
            <span className="bottom-nav-icon">{icon}</span>
            <span className="bottom-nav-label">{item.label}</span>
          </Link>
        );
      })}

      <style>{navStyle}</style>
    </nav>
  );
}

const navStyle = `
  .bottom-nav {
    position: fixed;
    bottom: -3px;
    left: 0;
    right: 0;
    z-index: 200;
    height: var(--bottom-nav-h, 56px);
    display: flex;
    align-items: stretch;
    background: rgba(0, 0, 0, 0.92);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    padding-bottom: 5px;
  }

  .seekbar-track {
    position: absolute;
    top: -14px;
    left: 0;
    right: 0;
    height: 20px;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: none;
    user-select: none;
    z-index: 10;
    display: flex;
    align-items: center;
  }

  .seekbar-track::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    height: 3px;
    background: rgba(255, 255, 255, 0.2);
    border-radius: 999px;
  }

  .seekbar-fill {
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    height: 3px;
    background: #fff;
    border-radius: 999px;
    pointer-events: none;
    transition: width 0.1s linear;
  }

  .seekbar-thumb {
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%) scale(0);
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    pointer-events: none;
    transition: transform 0.15s ease, left 0.1s linear;
    box-shadow: 0 1px 4px rgba(0,0,0,0.5);
  }

  .seekbar-track:hover .seekbar-fill,
  .seekbar-track:active .seekbar-fill {
    height: 5px;
  }
  .seekbar-track:hover .seekbar-thumb,
  .seekbar-track:active .seekbar-thumb {
    transform: translate(-50%, -50%) scale(1);
  }
  .seekbar-track:hover::before,
  .seekbar-track:active::before {
    height: 5px;
  }

  .bottom-nav-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    text-decoration: none;
    color: rgba(255, 255, 255, 0.45);
    -webkit-tap-highlight-color: transparent;
    transition: color 0.15s ease;
    padding-bottom: 2px;
    cursor: pointer;
  }

  .bottom-nav-item--active {
    color: #fff;
    cursor: default;
  }

  .bottom-nav-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }

  .bottom-nav-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }
`;
