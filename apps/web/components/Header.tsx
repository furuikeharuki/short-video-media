"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";

export default function Header() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    // アニメ完了後にフォーカス
    setTimeout(() => inputRef.current?.focus(), 120);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const q = inputRef.current?.value.trim();
      if (!q) return;
      closeSearch();
      router.push(`/search?q=${encodeURIComponent(q)}`);
    },
    [router, closeSearch]
  );

  return (
    <header className="site-header">
      {/* ── ロゴ ── */}
      <Link href="/" className="header-logo" aria-label="トップへ戻る">
        <svg
          width="32"
          height="32"
          viewBox="0 0 32 32"
          fill="none"
          aria-hidden="true"
        >
          {/* 再生ボタン風ロゴマーク */}
          <rect width="32" height="32" rx="8" fill="#E8003D" />
          <path d="M12 9.5L23 16L12 22.5V9.5Z" fill="white" />
        </svg>
        <span className="header-logo-text">ShortVid</span>
      </Link>

      {/* ── 右側エリア ── */}
      <div className="header-actions">
        {/* 検索バー（展開時） */}
        <form
          className={`header-search-form ${searchOpen ? "is-open" : ""}`}
          onSubmit={handleSubmit}
          role="search"
        >
          <input
            ref={inputRef}
            type="search"
            placeholder="タイトル・女優・ジャンル"
            className="header-search-input"
            aria-label="動画を検索"
            onBlur={closeSearch}
          />
        </form>

        {/* 検索アイコンボタン */}
        <button
          className="header-icon-btn"
          aria-label="検索を開く"
          onClick={openSearch}
          type="button"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="22" y2="22" />
          </svg>
        </button>
      </div>
    </header>
  );
}
