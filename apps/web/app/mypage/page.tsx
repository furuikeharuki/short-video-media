"use client";

import { useEffect, useState } from "react";
import { useSession, signIn } from "next-auth/react";

import MovieCardThumb from "@/components/home/MovieCardThumb";
import {
  getBookmarks,
  getViews,
  type BookmarkItem,
  type ViewItem,
} from "@/lib/api/me";
import type { MovieCard } from "@/lib/api/feed";

type Tab = "bookmarks" | "views";

export default function MyPage() {
  const { status } = useSession();
  const [tab, setTab] = useState<Tab>("bookmarks");
  const [bookmarks, setBookmarks] = useState<BookmarkItem[] | null>(null);
  const [views, setViews] = useState<ViewItem[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const [b, v] = await Promise.all([getBookmarks({ limit: 100 }), getViews({ limit: 100 })]);
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
    <main className="mypage-main">
      <div className="mypage-tabs">
        <button
          type="button"
          className={`mypage-tab${tab === "bookmarks" ? " mypage-tab--active" : ""}`}
          onClick={() => setTab("bookmarks")}
        >
          ブックマーク
        </button>
        <button
          type="button"
          className={`mypage-tab${tab === "views" ? " mypage-tab--active" : ""}`}
          onClick={() => setTab("views")}
        >
          視聴履歴
        </button>
      </div>

      {loading ? (
        <div className="mypage-empty">読み込み中...</div>
      ) : tab === "bookmarks" ? (
        <BookmarkList items={bookmarks ?? []} />
      ) : (
        <ViewList items={views ?? []} />
      )}

      <style>{styles}</style>
    </main>
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
  return (
    <div className="mypage-grid">
      {items.map((b) => (
        <MovieCardThumb key={b.movie.id} movie={b.movie as MovieCard} aspect="portrait" />
      ))}
    </div>
  );
}

function ViewList({ items }: { items: ViewItem[] }) {
  if (items.length === 0) {
    return <div className="mypage-empty">まだ視聴履歴がありません。</div>;
  }
  return (
    <div className="mypage-grid">
      {items.map((v) => (
        <MovieCardThumb key={v.movie.id} movie={v.movie as MovieCard} aspect="portrait" />
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
    padding: 16px;
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
  .mypage-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
    border-bottom: 1px solid rgba(255,255,255,0.1);
  }
  .mypage-tab {
    background: none;
    border: none;
    color: rgba(255,255,255,0.6);
    padding: 12px 16px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  .mypage-tab--active {
    color: #fff;
    border-bottom-color: #e91e63;
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
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  @media (max-width: 480px) {
    .mypage-grid { grid-template-columns: repeat(2, 1fr); }
  }
`;
