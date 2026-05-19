"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession, signIn } from "next-auth/react";

import MovieCardThumb from "@/components/home/MovieCardThumb";
import PullToRefresh from "@/components/home/PullToRefresh";
import {
  getBookmarks,
  getViews,
  type BookmarkItem,
  type ViewItem,
} from "@/lib/api/me";
import type { MovieCard } from "@/lib/api/feed";

type Tab = "bookmarks" | "views";
const TABS: Tab[] = ["bookmarks", "views"];

// スワイプで切り替えと判定するしきい値 (ピクセル)
const SWIPE_THRESHOLD = 60;
// 縦スクロールと区別するための、横優位とみなす最小比率
const HORIZONTAL_RATIO = 1.2;

export default function MyPage() {
  const { status } = useSession();
  const [tab, setTab] = useState<Tab>("bookmarks");
  const [bookmarks, setBookmarks] = useState<BookmarkItem[] | null>(null);
  const [views, setViews] = useState<ViewItem[] | null>(null);
  const [loading, setLoading] = useState(false);

  // タブ切替時はスクロールを一番上に戻す
  // (短いタブと長いタブで縦位置がずれるのを防ぐ)
  const handleTabChange = useCallback((next: Tab) => {
    setTab(next);
    if (typeof document !== "undefined") {
      const el = document.querySelector<HTMLElement>(".mypage-main");
      if (el) el.scrollTo({ top: 0, behavior: "auto" });
    }
  }, []);

  const loadData = useCallback(async () => {
    const [b, v] = await Promise.all([
      getBookmarks({ limit: 100 }),
      getViews({ limit: 100 }),
    ]);
    setBookmarks(b);
    setViews(v);
  }, []);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const [b, v] = await Promise.all([
        getBookmarks({ limit: 100 }),
        getViews({ limit: 100 }),
      ]);
      if (!cancelled) {
        setBookmarks(b);
        setViews(v);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status]);

  if (status === "loading") {
    return (
      <main className="mypage-main">
        <div className="mypage-empty">読み込み中...</div>
        <style>{styles}</style>
      </main>
    );
  }

  if (status !== "authenticated") {
    return (
      <main className="mypage-main">
        <div className="mypage-auth">
          <h1 className="mypage-title">マイページ</h1>
          <p className="mypage-lead">
            ブックマークや視聴履歴を確認するにはログインしてください。
          </p>
          <button
            type="button"
            className="mypage-btn mypage-btn--twitter"
            onClick={() => signIn("twitter", { callbackUrl: "/mypage" })}
          >
            X (Twitter) でログイン
          </button>
          <button
            type="button"
            className="mypage-btn mypage-btn--discord"
            onClick={() => signIn("discord", { callbackUrl: "/mypage" })}
          >
            Discord でログイン
          </button>
          <p className="mypage-legal">
            このサイトはメールアドレスや名前などの個人情報を一切受け取りません。
            ログイン用の識別子のみを保存します。
          </p>
        </div>
        <style>{styles}</style>
      </main>
    );
  }

  return (
    <PullToRefresh className="mypage-main" onRefresh={loadData}>
      <TabSwiper
        tab={tab}
        onChange={handleTabChange}
        bookmarks={bookmarks}
        views={views}
        loading={loading}
      />
      <style>{styles}</style>
    </PullToRefresh>
  );
}

interface TabSwiperProps {
  tab: Tab;
  onChange: (tab: Tab) => void;
  bookmarks: BookmarkItem[] | null;
  views: ViewItem[] | null;
  loading: boolean;
}

/**
 * ブックマーク <-> 視聴履歴 を横スワイプで切り替える 2 ペインコンテナ。
 * - タブボタンタップでもアニメーションして移動
 * - 指で横にドラッグして閾値超えで切替、未満なら戻る
 * - 最初の数 px で「横優位」なジェスチャかを判定し、縦スクロールを邪魔しない
 */
function TabSwiper({
  tab,
  onChange,
  bookmarks,
  views,
  loading,
}: TabSwiperProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tabIndex = TABS.indexOf(tab);

  // ドラッグ状態
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const lockedAxisRef = useRef<"horizontal" | "vertical" | null>(null);
  const [dragDx, setDragDx] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    startRef.current = { x: t.clientX, y: t.clientY };
    lockedAxisRef.current = null;
    setDragDx(0);
    setIsDragging(false);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (!startRef.current) return;
    const t = e.touches[0];
    const dx = t.clientX - startRef.current.x;
    const dy = t.clientY - startRef.current.y;

    // 軸ロックがまだなら判定
    if (lockedAxisRef.current === null) {
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      // 微小ジェスチャは無視
      if (absX < 8 && absY < 8) return;
      lockedAxisRef.current =
        absX > absY * HORIZONTAL_RATIO ? "horizontal" : "vertical";
    }

    if (lockedAxisRef.current !== "horizontal") return;

    // 端で更に外側へ引っ張る場合は抵抗をかける
    let effectiveDx = dx;
    if (tabIndex === 0 && dx > 0) effectiveDx = dx * 0.35;
    if (tabIndex === TABS.length - 1 && dx < 0) effectiveDx = dx * 0.35;

    setIsDragging(true);
    setDragDx(effectiveDx);
  };

  const finishDrag = () => {
    if (lockedAxisRef.current === "horizontal" && containerRef.current) {
      const width = containerRef.current.clientWidth;
      const ratio = Math.abs(dragDx) / Math.max(width, 1);
      let nextIndex = tabIndex;
      if (dragDx <= -SWIPE_THRESHOLD && tabIndex < TABS.length - 1) {
        nextIndex = tabIndex + 1;
      } else if (dragDx >= SWIPE_THRESHOLD && tabIndex > 0) {
        nextIndex = tabIndex - 1;
      } else if (ratio > 0.25) {
        if (dragDx < 0 && tabIndex < TABS.length - 1) nextIndex = tabIndex + 1;
        else if (dragDx > 0 && tabIndex > 0) nextIndex = tabIndex - 1;
      }
      if (nextIndex !== tabIndex) {
        onChange(TABS[nextIndex]);
      }
    }
    startRef.current = null;
    lockedAxisRef.current = null;
    setDragDx(0);
    setIsDragging(false);
  };

  const onTouchEnd = () => finishDrag();
  const onTouchCancel = () => finishDrag();

  // translateX 計算: 各ペインは 100% 幅。タブ index 分だけ左へ寄せ、ドラッグ分を加算
  const translateExpr =
    isDragging && dragDx !== 0
      ? `calc(${-tabIndex * 100}% + ${dragDx}px)`
      : `${-tabIndex * 100}%`;

  return (
    <div className="mypage-swipe-root">
      <div className="mypage-tabs">
        <button
          type="button"
          className={`mypage-tab${tab === "bookmarks" ? " mypage-tab--active" : ""}`}
          onClick={() => onChange("bookmarks")}
        >
          ブックマーク
        </button>
        <button
          type="button"
          className={`mypage-tab${tab === "views" ? " mypage-tab--active" : ""}`}
          onClick={() => onChange("views")}
        >
          視聴履歴
        </button>
        <span
          className="mypage-tab-indicator"
          style={{ transform: `translateX(${tabIndex * 100}%)` }}
          aria-hidden="true"
        />
      </div>

      <div
        ref={containerRef}
        className="mypage-swipe-viewport"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
      >
        <div
          className={`mypage-swipe-track${isDragging ? " is-dragging" : ""}`}
          style={{ transform: `translate3d(${translateExpr}, 0, 0)` }}
        >
          <div
            className={`mypage-swipe-pane${
              tab === "bookmarks" ? " is-active" : ""
            }${isDragging ? " is-dragging" : ""}`}
            aria-hidden={tab !== "bookmarks" && !isDragging}
          >
            {loading && bookmarks === null ? (
              <div className="mypage-empty">読み込み中...</div>
            ) : (
              <BookmarkList items={bookmarks ?? []} />
            )}
          </div>
          <div
            className={`mypage-swipe-pane${
              tab === "views" ? " is-active" : ""
            }${isDragging ? " is-dragging" : ""}`}
            aria-hidden={tab !== "views" && !isDragging}
          >
            {loading && views === null ? (
              <div className="mypage-empty">読み込み中...</div>
            ) : (
              <ViewList items={views ?? []} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BookmarkList({ items }: { items: BookmarkItem[] }) {
  if (items.length === 0) {
    return (
      <div className="mypage-empty">
        まだブックマークがありません。気に入った作品があったらフィードのブックマークボタンを押してみてください。
      </div>
    );
  }
  // ブックマーク一覧をそのままプレイリスト化し、タップした作品からフィード再生を開始する
  const movies = items.map((b) => b.movie);
  return (
    <div className="mypage-grid">
      {items.map((b, index) => (
        <MovieCardThumb
          key={b.movie.id}
          movie={b.movie as MovieCard}
          aspect="portrait"
          fluid
          playlist={{
            key: `mypage-bookmarks-${b.movie.id}`,
            title: "ブックマーク",
            startIndex: index,
            items: movies,
          }}
        />
      ))}
    </div>
  );
}

function ViewList({ items }: { items: ViewItem[] }) {
  if (items.length === 0) {
    return <div className="mypage-empty">まだ視聴履歴がありません。</div>;
  }
  // 視聴履歴一覧をそのままプレイリスト化し、タップした作品からフィード再生を開始する
  const movies = items.map((v) => v.movie);
  return (
    <div className="mypage-grid">
      {items.map((v, index) => (
        <MovieCardThumb
          key={v.movie.id}
          movie={v.movie as MovieCard}
          aspect="portrait"
          fluid
          playlist={{
            key: `mypage-views-${v.movie.id}`,
            title: "視聴履歴",
            startIndex: index,
            items: movies,
          }}
        />
      ))}
    </div>
  );
}

const styles = `
  html { background: #000; }
  body { background: #000; }
  .mypage-main {
    position: fixed;
    top: var(--header-h, 52px);
    left: 0; right: 0;
    bottom: var(--bottom-nav-h, 56px);
    overflow-y: auto;
    overflow-x: hidden;
    -webkit-overflow-scrolling: touch;
    background: #000;
    color: #fff;
  }
  .mypage-title {
    font-size: 22px;
    font-weight: 800;
    margin: 0 0 12px;
    letter-spacing: -0.01em;
  }
  .mypage-lead {
    font-size: 14px;
    color: rgba(255,255,255,0.7);
    line-height: 1.7;
    margin: 0 0 24px;
  }
  .mypage-auth {
    max-width: 360px;
    margin: 40px auto;
    padding: 24px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 16px;
  }
  .mypage-btn {
    display: block;
    width: 100%;
    padding: 14px;
    font-size: 15px;
    font-weight: 700;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    margin-bottom: 10px;
    color: #fff;
  }
  .mypage-btn--twitter { background: #000; border: 1px solid rgba(255,255,255,0.2); }
  .mypage-btn--discord { background: #5865F2; }
  .mypage-legal {
    margin-top: 16px;
    font-size: 11px;
    color: rgba(255,255,255,0.4);
    line-height: 1.7;
  }

  /* タブ + スワイプビューポート */
  .mypage-swipe-root {
    width: 100%;
  }
  .mypage-tabs {
    position: relative;
    display: flex;
    border-bottom: 1px solid rgba(255,255,255,0.1);
    margin: 0 0 12px;
  }
  .mypage-tab {
    flex: 1 1 0;
    background: none;
    border: none;
    color: rgba(255,255,255,0.6);
    padding: 12px 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    text-align: center;
    transition: color 0.2s ease;
  }
  .mypage-tab--active {
    color: #fff;
  }
  .mypage-tab-indicator {
    position: absolute;
    bottom: -1px;
    left: 0;
    width: 50%;
    height: 2px;
    background: #e91e63;
    transform: translateX(0);
    transition: transform 0.22s cubic-bezier(0.2, 0.7, 0.2, 1);
    pointer-events: none;
  }
  .mypage-swipe-viewport {
    width: 100%;
    overflow: hidden;
    touch-action: pan-y;
  }
  .mypage-swipe-track {
    display: flex;
    width: 100%;
    align-items: flex-start;
    transition: transform 0.22s cubic-bezier(0.2, 0.7, 0.2, 1);
    will-change: transform;
  }
  .mypage-swipe-track.is-dragging {
    transition: none;
  }
  .mypage-swipe-pane {
    flex: 0 0 100%;
    width: 100%;
    min-width: 0;
    padding: 0 16px 16px;
    /* 非アクティブペインは高さを 0 にしてスクロール領域を伸ばさない
       (アクティブタブのコンテンツ量よりも下にスクロールできないようにする)。
       ドラッグ中は隣ペインも見える必要があるので例外的に展開する。 */
    max-height: 0;
    overflow: hidden;
  }
  .mypage-swipe-pane.is-active,
  .mypage-swipe-pane.is-dragging {
    max-height: none;
    overflow: visible;
  }

  .mypage-empty {
    padding: 60px 20px;
    text-align: center;
    color: rgba(255,255,255,0.5);
    font-size: 14px;
    line-height: 1.7;
  }
  .mypage-grid {
    display: grid;
    /* minmax(0, 1fr) でコンテンツの最小幅に引っ張られて列幅に差を出さない */
    /* スマホ (デフォ) : 最低 3 列 */
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  /* タブレット : 4 列 */
  @media (min-width: 481px) {
    .mypage-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }
  /* 小型 PC / 大きめタブレット : 5 列 */
  @media (min-width: 640px) {
    .mypage-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  }
  /* PC : 6 列 */
  @media (min-width: 900px) {
    .mypage-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  }
  /* ワイド PC : 7 列 + 中央寄せ */
  @media (min-width: 1200px) {
    .mypage-grid {
      grid-template-columns: repeat(7, minmax(0, 1fr));
      max-width: 1200px;
      margin: 0 auto;
    }
  }
  /* 大画面 PC : 8 列 */
  @media (min-width: 1500px) {
    .mypage-grid { grid-template-columns: repeat(8, minmax(0, 1fr)); }
  }
`;
