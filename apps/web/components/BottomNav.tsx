"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useCallback, useState } from "react";
import { markFeedStartUnmuted } from "@/lib/feedNav";

// ショートボタンを押して /feed に遷移するときに、保存されているフィードのスナップショットを破棄して
// ランダム再生を保証する。FeedClient 側は sessionStorage が空なら getFeed を新しい seed で取り直す。
// さらに、このクリックをユーザージェスチャーとして採用し、次のフィード起動時に音声 ON で始まるようフラグを立てる
function resetFeedSession() {
  try {
    sessionStorage.removeItem("feed_seed");
    sessionStorage.removeItem("feed_index");
    sessionStorage.removeItem("feed_items");
  } catch {
    /* ignore */
  }
  markFeedStartUnmuted();
}

const NAV_ITEMS = [
  {
    label: "ホーム",
    href: "/",
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
    href: "/feed",
    // 動画再生中 (フィード + 動画詳細 + モーダル) はすべて「ショート」をアクティブ表示にする。
    // /movies/* は動画詳細ページ および モーダル経由でも同じ pathname になるため、ここで拾う。
    extraActive: ["/search/feed", "/movies/"],
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

// ナビゲーションを非表示にするパス。
// - /age-gate: 年齢確認を通さずにショート/ホーム等へ遷移されないように
// - /actresses, /movies: 詳細ページは没入型レイアウトのためボトムナビを隠す
//
// 注意: Next.js 15 では window.history.pushState を usePathname が拾うため、
// /feed 上で MovieDetailModal を開く (pushState で URL を /movies/<slug> に書き換える) と、
// 上の "/movies" にヒットして BottomNav が一緒に消えてしまう。
// それを防ぐため、MovieDetailModal が dispatch する "modal-open" / "modal-close" イベントを
// 監視し、フィード上モーダル中は強制的に「/feed と同じ表示状態」を保つ。
const NAV_HIDDEN_PATHS = ["/age-gate", "/actresses", "/movies"];

export default function BottomNav() {
  const pathname    = usePathname();
  // /feed 上で MovieDetailModal を開いている間 true。
  // pushState によって pathname が /movies/<slug> に変わっても、BottomNav は
  // フィード視聴中と同じ振る舞い (表示 + シークバー + ショートアクティブ) を維持する。
  const [isFeedModalOpen, setIsFeedModalOpen] = useState(false);

  useEffect(() => {
    // 同値の setState は React がスケジューラ段階で bail-out するが、
    // 「modal-open / modal-close が連続で来る」シーンを明示的に no-op にしておく
    // (StrictMode 二重実行や、親側でモーダルを再 mount したときの安全弁)。
    const onOpen  = () => setIsFeedModalOpen((prev) => (prev ? prev : true));
    const onClose = () => setIsFeedModalOpen((prev) => (prev ? false : prev));
    window.addEventListener("modal-open",  onOpen);
    window.addEventListener("modal-close", onClose);
    return () => {
      window.removeEventListener("modal-open",  onOpen);
      window.removeEventListener("modal-close", onClose);
    };
  }, []);

  const isShortPage = pathname === "/feed" || pathname.startsWith("/search/feed") || isFeedModalOpen;
  // フィード上モーダル中は pathname が /movies/<slug> でも「非表示パス」とは扱わない。
  const isHidden    = !isFeedModalOpen && NAV_HIDDEN_PATHS.some((p) => pathname.startsWith(p));

  const trackRef   = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const [progress, setProgress] = useState(0);

  // 「ショートページにいるかどうか」を ref にミラーして、video-progress リスナを
  // useEffect の依存に乗せずに済むようにする。依存に isShortPage を載せていた以前の
  // 実装では、modal-open/close で isFeedModalOpen が変化するたびに effect cleanup →
  // setup が走り、video-progress (60fps) との組合せで稀に React の更新スタック
  // (Maximum update depth exceeded) を踏むケースがあった。リスナはマウント中
  // 1 度だけ登録し、ハンドラ内で ref を見て setState するか判断する。
  const isShortPageRef = useRef(isShortPage);
  useEffect(() => {
    isShortPageRef.current = isShortPage;
  }, [isShortPage]);

  useEffect(() => {
    const handler = (e: CustomEvent<{ progress: number }>) => {
      if (!isShortPageRef.current) return;
      if (isDragging.current) return;
      const next = e.detail.progress;
      // 同値で setState すると React は bail-out するが、念のため明示的にガードして
      // 不要な再レンダーを完全に避ける。
      setProgress((prev) => (prev === next ? prev : next));
    };
    window.addEventListener("video-progress", handler);
    return () => window.removeEventListener("video-progress", handler);
  }, []);

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

  // ナビを非表示にするパス (年齢確認ページなど) では何もレンダリングしない。
  // フックの起動順序を守るため、早期 return はフック定義の後に置く。
  if (isHidden) {
    return null;
  }

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
          item.extraActive.some((p) => pathname.startsWith(p)) ||
          (item.href === "/feed" && pathname === "/feed");
        const icon = isActive ? item.iconFilled : item.iconOutline;

        if (isActive) {
          return (
            <span key={item.href} className="bottom-nav-item bottom-nav-item--active" aria-current="page">
              <span className="bottom-nav-icon">{icon}</span>
              <span className="bottom-nav-label">{item.label}</span>
            </span>
          );
        }
        const handleNavClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
          if (item.href === "/feed") {
            resetFeedSession();
          }
          if (
            e.defaultPrevented ||
            e.button !== 0 ||
            e.metaKey ||
            e.ctrlKey ||
            e.shiftKey ||
            e.altKey
          ) {
            return;
          }
          // /feed (ショート動画画面) との出入りはどちら向きも常にフルページ遷移にする。
          //
          // フィード画面は以下が複雑に絡んでおり、SPA 遷移 (router.push / <Link>) では
          // 確実に動かない:
          //   1. MovieDetailModal が window.history.pushState で URL を /movies/<slug> に
          //      書き換え、unmount 時に replaceState で戻す。Next.js 15 のパッチ済 history
          //      API はこれを usePathname に反映するが、cleanup のタイミングで router.push が
          //      打ち消されることがある。
          //   2. @modal 並列ルート (/(.)movies/[slug]) のスロット状態が、フィード上での
          //      pushState/replaceState によって不整合を起こし、SPA 遷移が止まることがある。
          //   3. FeedClient は <video>・sessionStorage・IntersectionObserver・useFeedPlayback
          //      の自動再生 effect 等の副作用を多数持ち、SPA mount だと初回再生のための
          //      ユーザージェスチャー context が失われて <video> が play() できず黒画面のまま
          //      止まるケースがある (リロードなら直る = サーバ HTML から正規ロードされるため)。
          //
          // window.location.assign に統一すれば、ブラウザが新しい URL をフェッチして
          // クリーンに遷移するため、上記いずれの状態にも左右されず確実に動く。
          // フィードを出入りする時点でフィードの全状態は再構築されるので、SPA 遷移に
          // こだわる必要は薄い。
          const onShortFeed =
            pathname === "/feed" ||
            pathname.startsWith("/search/feed") ||
            pathname.startsWith("/movies/") ||
            isFeedModalOpen;
          const goingToFeed = item.href === "/feed";
          if ((onShortFeed && item.href !== "/feed") || goingToFeed) {
            e.preventDefault();
            window.location.assign(item.href);
          }
          // それ以外は <Link> のデフォルト挙動 (Next の SPA 遷移) に任せる。
        };
        return (
          <Link
            key={item.href}
            href={item.href}
            className="bottom-nav-item"
            onClick={handleNavClick}
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
