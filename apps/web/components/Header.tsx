"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPopularTags, FALLBACK_TAGS } from "@/lib/api/tags";

export default function Header() {
  const router      = useRouter();
  const inputRef    = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const btnRef      = useRef<HTMLButtonElement>(null);

  const [open, setOpen]         = useState(false);
  const [query, setQuery]       = useState("");
  const [tags, setTags]         = useState<string[]>(FALLBACK_TAGS);
  const [tagsFetched, setFetched] = useState(false);

  // 検索プルダウンを初回開いたタイミングでタグを取得（不必要なリクエストを削減）
  const loadTags = useCallback(async () => {
    if (tagsFetched) return;
    setFetched(true);
    const result = await fetchPopularTags(20);
    setTags(result);
  }, [tagsFetched]);

  // プルダウン外クリック / タッチで閉じる
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => {
      if (
        dropdownRef.current?.contains(e.target as Node) ||
        btnRef.current?.contains(e.target as Node)
      ) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
    };
  }, [open]);

  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next) {
        setTimeout(() => inputRef.current?.focus(), 80);
        loadTags(); // 初回開いたときにタグを取得
      }
      return next;
    });
  }, [loadTags]);

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

  return (
    <header className="site-header">
      <Link href="/" className="header-logo" aria-label="トップへ戻る">
        <span className="header-logo-text">ShortVid</span>
      </Link>

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
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <line x1="4" y1="4" x2="20" y2="20" />
              <line x1="20" y1="4" x2="4" y2="20" />
            </svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
        <form
          onSubmit={(e) => { e.preventDefault(); submit(query); }}
          role="search"
          className="search-form"
        >
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

        <div className="search-tags-section">
          <p className="search-tags-label">人気タグ</p>
          <div className="search-tags">
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                className="search-tag-btn"
                onClick={() => submit(tag)}
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
