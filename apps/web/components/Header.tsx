"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

// 人気タグは将来アピーから取得する想定。今はハードコード。
const POPULAR_TAGS = [
  "素人", "美少女", "OL", "創作", "ハード", "女優情報",
  "中出し", "プロ作品", "VR", "ランキング上位",
];

export default function Header() {
  const router = useRouter();
  const inputRef    = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const btnRef      = useRef<HTMLButtonElement>(null);

  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState("");

  // プルダウン外クリックで閉じる
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current?.contains(e.target as Node) ||
        btnRef.current?.contains(e.target as Node)
      ) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // プルダウン外タッチで閉じる（スマホ）
  useEffect(() => {
    if (!open) return;
    const handler = (e: TouchEvent) => {
      if (
        dropdownRef.current?.contains(e.target as Node) ||
        btnRef.current?.contains(e.target as Node)
      ) return;
      setOpen(false);
    };
    document.addEventListener("touchstart", handler);
    return () => document.removeEventListener("touchstart", handler);
  }, [open]);

  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      if (!prev) setTimeout(() => inputRef.current?.focus(), 80);
      return !prev;
    });
  }, []);

  const submit = useCallback(
    (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      setOpen(false);
      setQuery("");
      router.push(`/search?q=${encodeURIComponent(trimmed)}`);
    },
    [router]
  );

  const handleFormSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      submit(query);
    },
    [query, submit]
  );

  const handleTag = useCallback(
    (tag: string) => {
      submit(tag);
    },
    [submit]
  );

  return (
    <header className="site-header">
      {/* ロゴ */}
      <Link href="/" className="header-logo" aria-label="トップへ戻る">
        <span className="header-logo-text">ShortVid</span>
      </Link>

      {/* 右側 */}
      <div className="header-actions">
        <button
          ref={btnRef}
          className={`header-icon-btn${open ? " is-active" : ""}`}
          aria-label="検索"
          aria-expanded={open}
          aria-controls="search-dropdown"
          onClick={toggleOpen}
          type="button"
        >
          {open ? (
            /* 閉じる： × */
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round" aria-hidden="true">
              <line x1="4" y1="4" x2="20" y2="20" />
              <line x1="20" y1="4" x2="4" y2="20" />
            </svg>
          ) : (
            /* 開く：検索 */
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <line x1="16.5" y1="16.5" x2="22" y2="22" />
            </svg>
          )}
        </button>
      </div>

      {/* 検索プルダウン */}
      <div
        id="search-dropdown"
        ref={dropdownRef}
        className={`search-dropdown${open ? " is-open" : ""}`}
        aria-hidden={!open}
      >
        {/* フリーワード検索 */}
        <form onSubmit={handleFormSubmit} role="search" className="search-form">
          <div className="search-input-wrap">
            <svg className="search-input-icon" width="18" height="18" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <line x1="16.5" y1="16.5" x2="22" y2="22" />
            </svg>
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="タイトル・女優・ジャンルを入力"
              className="search-input"
              aria-label="フリーワード検索"
              autoComplete="off"
            />
            {query && (
              <button
                type="button"
                className="search-clear-btn"
                aria-label="入力をクリア"
                onClick={() => { setQuery(""); inputRef.current?.focus(); }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                  <line x1="4" y1="4" x2="20" y2="20" />
                  <line x1="20" y1="4" x2="4" y2="20" />
                </svg>
              </button>
            )}
          </div>
          <button type="submit" className="search-submit-btn" disabled={!query.trim()}>
            検索
          </button>
        </form>

        {/* 人気タグ */}
        <div className="search-tags-section">
          <p className="search-tags-label">人気タグ</p>
          <div className="search-tags">
            {POPULAR_TAGS.map((tag) => (
              <button
                key={tag}
                type="button"
                className="search-tag-btn"
                onClick={() => handleTag(tag)}
              >
                #{tag}
              </button>
            ))}
          </div>
        </div>
      </div>
    </header>
  );
}
