"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { fetchPopularTags } from "@/lib/api/tags";
import HamburgerMenu from "@/components/HamburgerMenu";
import AdvancedSearchPanel from "@/components/AdvancedSearchPanel";
import { logEvent } from "@/lib/api/events";

const FEED_SEED_KEY  = "feed_seed";
const FEED_INDEX_KEY = "feed_index";
const FEED_ITEMS_KEY = "feed_items";

// ヘッダーを非表示にするパス (年齢確認ページなど)。
// 年齢確認を通さずにロゴからボトムナビやハンバーガーメニュー経由で遷移されてしまうのを防ぐ。
const HEADER_HIDDEN_PATHS = ["/age-gate"];

export default function Header() {
  const router      = useRouter();
  const pathname    = usePathname();
  const isHidden    = HEADER_HIDDEN_PATHS.some((p) => pathname.startsWith(p));
  const inputRef    = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const btnRef      = useRef<HTMLButtonElement>(null);
  const wrapperRef  = useRef<HTMLDivElement>(null);

  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState("");
  // 詳細検索パネルの開閉。検索ドロップダウンが閉じれば自動的に閉じる扱い (ドロップダウンの内側に置く)。
  const [advOpen, setAdvOpen] = useState(false);
  const { status } = useSession();
  const isAuthed = status === "authenticated";
  // 人気ジャンル TOP10 (登録数の多い順)。
  // デフォルトは空配列 (= タグ非表示) にして、画面ロード時に DB から取得し保持しておく。
  // API 失敗時もハードコードのフォールバックは出さず空のままにする。
  const [popularGenres, setPopularGenres] = useState<string[]>([]);

  // ヘッダーがマウントされた直後 (= 画面ロード時) に人気ジャンルを取得。
  // ドロップダウンを開く前から手元に持っておくので、開いたときに即座に表示できる。
  useEffect(() => {
    let cancelled = false;
    fetchPopularTags(10)
      .then((list) => {
        if (cancelled) return;
        if (list.length > 0) setPopularGenres(list);
      })
      .catch(() => { /* 取得失敗時は空のまま (タグセクションは非表示) */ });
    return () => { cancelled = true; };
  }, []);

  // ヘッダーの実高さを --header-h に同期する。
  // safe-area-inset-top やフォントサイズの差異で 52px から微妙にズレるケースを吸収し、
  // モーダル・フィード・ボトムナビ等の top/padding がピッタリ追従するようにする。
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const apply = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h > 0) {
        document.documentElement.style.setProperty("--header-h", `${h}px`);
      }
    };

    apply();

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(apply);
      ro.observe(el);
    }
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);

    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
    };
  }, []);

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
      if (!prev) setTimeout(() => inputRef.current?.focus(), 80);
      return !prev;
    });
  }, []);

  const submit = useCallback(
    (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      setOpen(false);
      setAdvOpen(false);
      setQuery("");
      // 人気ジャンル集計用に search イベントを送る (失敗は無視)
      logEvent({ event_type: "search", search_query: trimmed });
      router.push(`/search?q=${encodeURIComponent(trimmed)}`);
    },
    [router]
  );

  // 詳細検索パネルから送られてきた URL に遷移する。
  // (パネル内で URLSearchParams を組み立て済みなので、ここでは router.push するだけ)
  const submitAdvanced = useCallback(
    (url: string) => {
      setOpen(false);
      setAdvOpen(false);
      setQuery("");
      logEvent({ event_type: "search", search_query: "__advanced__" });
      router.push(url);
    },
    [router]
  );

  // 人気ジャンルのタグをクリックしたとき: キーワード検索ではなくジャンル絞り込みに飛ばす。
  // SearchInfiniteGrid の kind:"genre" ルートに乗るので 20件前後ずつ全件読める。
  const submitGenre = useCallback(
    (genre: string) => {
      const trimmed = genre.trim();
      if (!trimmed) return;
      setOpen(false);
      setAdvOpen(false);
      setQuery("");
      logEvent({ event_type: "search", search_query: trimmed });
      router.push(`/search?genre=${encodeURIComponent(trimmed)}`);
    },
    [router]
  );

  const handleLogoClick = useCallback(() => {
    // フィードセッションを破棄しておく (次回ショートを開いたときにランダムになる)
    try {
      sessionStorage.removeItem(FEED_SEED_KEY);
      sessionStorage.removeItem(FEED_INDEX_KEY);
      sessionStorage.removeItem(FEED_ITEMS_KEY);
    } catch { /* ignore */ }
    window.location.href = "/";
  }, []);

  // ヘッダーを非表示にするページ (年齢確認など) ではロゴや検索ボタンを見せず、
  // 年齢確認を通さずにサイト内へ遷移できてしまうことを防ぐ。
  // フックの起動順序を守るため、早期 return はフック定義の後に置く。
  if (isHidden) {
    return null;
  }

  return (
    <div ref={wrapperRef} className="site-header-wrapper">
    <header className="site-header">
      <button
        type="button"
        className="header-logo"
        aria-label="トップへ戻る（リロード）"
        onClick={handleLogoClick}
      >
        <span className="header-logo-text">
          <span className="logo-av">AV</span>
          <span className="logo-shorts"> Shorts</span>
        </span>
      </button>

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
        <HamburgerMenu />
      </div>

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
          <button
            type="button"
            className={`search-filter-btn${advOpen ? " is-active" : ""}`}
            aria-label="詳細検索"
            aria-expanded={advOpen}
            aria-controls="search-advanced-panel"
            onClick={() => setAdvOpen((v) => !v)}
          >
            {/* フィルター/スライダー風アイコン */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="4" y1="6" x2="20" y2="6" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="18" x2="20" y2="18" />
              <circle cx="9" cy="6" r="2.2" fill="#0a0a0a" />
              <circle cx="15" cy="12" r="2.2" fill="#0a0a0a" />
              <circle cx="8" cy="18" r="2.2" fill="#0a0a0a" />
            </svg>
          </button>
          <button type="submit" className="search-submit-btn" disabled={!query.trim()}>
            検索
          </button>
        </form>

        {advOpen && (
          <div id="search-advanced-panel" className="search-advanced-wrap">
            <AdvancedSearchPanel
              isAuthed={isAuthed}
              onSubmit={submitAdvanced}
            />
          </div>
        )}

        {popularGenres.length > 0 && (
          <div className="search-tags-section">
            <p className="search-tags-label">人気ジャンル</p>
            <div className="search-tags">
              {popularGenres.map((genre) => (
                <button
                  key={genre}
                  type="button"
                  className="search-tag-btn"
                  onClick={() => submitGenre(genre)}
                >
                  #{genre}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <style>{logoStyle}</style>
    </header>
    </div>
  );
}

const logoStyle = `
  .site-header-wrapper {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 100;
    background: var(--header-bg, #000);
  }
  .header-logo {
    display: flex;
    align-items: center;
    gap: 8px;
    background: none;
    border: none;
    color: #fff;
    cursor: pointer;
    padding: 0;
    min-height: 44px;
    flex-shrink: 0;
    -webkit-tap-highlight-color: transparent;
  }
  .header-logo-text {
    font-size: 20px;
    font-weight: 800;
    letter-spacing: -0.02em;
    line-height: 1;
  }
  .logo-av {
    color: #e91e63;
  }
  .logo-shorts {
    color: #ffffff;
  }
`;
