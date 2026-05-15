"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="bottom-nav" aria-label="メインナビゲーション">
      {NAV_ITEMS.map((item) => {
        const isActive =
          (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)) ||
          item.extraActive.some((p) => pathname.startsWith(p));

        const icon = isActive ? item.iconFilled : item.iconOutline;

        // アクティブ時は <span> にしてリンク自体を無効化
        if (isActive) {
          return (
            <span
              key={item.href}
              className="bottom-nav-item bottom-nav-item--active"
              aria-current="page"
            >
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
    bottom: 0;
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
    padding-bottom: env(safe-area-inset-bottom);
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
