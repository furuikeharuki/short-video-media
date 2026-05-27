"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { signIn, signOut, useSession } from "next-auth/react";
import { markFeedStartUnmuted } from "@/lib/feedNav";
import { buildFeedHrefFromSavedPref } from "@/lib/savedSearchPrefs";

const MENU_ITEMS = [
  { label: "ホーム", href: "/" },
  { label: "おすすめフィード", href: "/feed" },
  { label: "マイページ", href: "/mypage", requireAuth: true },
  { label: "お問い合わせ", href: "/contact" },
  { label: "プライバシーポリシー", href: "/privacy" },
  { label: "特定商取引法に基づく表記", href: "/law" },
];

const authBtnStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "12px",
  background: "#e91e63",
  color: "#fff",
  fontSize: "14px",
  fontWeight: 700,
  border: "none",
  borderRadius: "10px",
  cursor: "pointer",
  textAlign: "center",
};

export default function HamburgerMenu() {
  const [open, setOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const { status } = useSession();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => {
      if (
        drawerRef.current?.contains(e.target as Node) ||
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

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="header-icon-btn"
        aria-label="メニュー"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <line x1="4" y1="4" x2="20" y2="20" />
            <line x1="20" y1="4" x2="4" y2="20" />
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        )}
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.6)",
            zIndex: 90,
            backdropFilter: "blur(2px)",
          }}
          aria-hidden="true"
        />
      )}

      <div
        ref={drawerRef}
        role="dialog"
        aria-label="メニュー"
        aria-modal="true"
        style={{
          position: "fixed",
          top: 0, right: 0, bottom: 0,
          width: "min(280px, 80vw)",
          background: "#111",
          zIndex: 100,
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.25s cubic-bezier(0.4,0,0.2,1)",
          display: "flex",
          flexDirection: "column",
          paddingTop: "52px",
          borderLeft: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        {/* ドロワー内ロゴ：購入ボタンと同じ #e91e63 */}
        <div style={{
          padding: "20px 24px 8px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          marginBottom: "4px",
        }}>
          <span style={{ fontSize: "18px", fontWeight: 800, letterSpacing: "-0.02em" }}>
            <span style={{ color: "#e91e63" }}>AV</span>
            <span style={{ color: "#fff" }}> Shorts</span>
          </span>
        </div>

        <nav style={{ padding: "8px 0" }}>
          {MENU_ITEMS.map((item) => {
            // requireAuth のメニュー項目は未ログイン時に非表示
            if (item.requireAuth && status !== "authenticated") return null;
            const goingToFeed = item.href === "/feed";
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={(e) => {
                  if (goingToFeed && typeof window !== "undefined") {
                    // 前回のフィードセッションを完全に破棄 (filter_sig / next_cursor 含む)。
                    // BottomNav の resetFeedSession と同じ挙動にして、ハンバーガー経由でも
                    // 状態の混線で「フィルター違反作品の通常フィードが残る」事故を防ぐ。
                    try {
                      sessionStorage.removeItem("feed_seed");
                      sessionStorage.removeItem("feed_index");
                      sessionStorage.removeItem("feed_items");
                      sessionStorage.removeItem("feed_filter_sig");
                      sessionStorage.removeItem("feed_next_cursor");
                    } catch {}
                    markFeedStartUnmuted();
                    // 保存済み詳細検索条件 (フリーワード / チップ / NG / ソート) を
                    // URL クエリに展開してフルページ遷移する。BottomNav と同じ動線にして、
                    // 初回マウントから FeedClient が hasAnyFilter=true で fetch 開始 →
                    // 0 件のとき「該当する作品が見つかりませんでした」を確実に出す。
                    if (
                      !e.defaultPrevented &&
                      e.button === 0 &&
                      !e.metaKey &&
                      !e.ctrlKey &&
                      !e.shiftKey &&
                      !e.altKey
                    ) {
                      e.preventDefault();
                      const targetHref = buildFeedHrefFromSavedPref();
                      window.location.assign(targetHref);
                    }
                  }
                  setOpen(false);
                }}
                style={{
                  display: "block",
                  padding: "14px 24px",
                  color: "#fff",
                  fontSize: "15px",
                  fontWeight: 500,
                  textDecoration: "none",
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                  transition: "background 0.15s ease",
                }}
              >
                {item.label}
              </Link>
            );
          })}

          {/* ログイン / ログアウト */}
          <div style={{ padding: "16px 24px 8px", borderTop: "1px solid rgba(255,255,255,0.08)", marginTop: "8px" }}>
            {status === "authenticated" ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  signOut({ callbackUrl: "/" });
                }}
                style={authBtnStyle}
              >
                ログアウト
              </button>
            ) : status === "loading" ? (
              <div style={{ ...authBtnStyle, opacity: 0.5, textAlign: "center" }}>読み込み中...</div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    signIn("twitter", { callbackUrl: "/mypage" });
                  }}
                  style={{ ...authBtnStyle, background: "#000", marginBottom: "8px" }}
                >
                  X (Twitter) でログイン
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    signIn("discord", { callbackUrl: "/mypage" });
                  }}
                  style={{ ...authBtnStyle, background: "#5865F2" }}
                >
                  Discord でログイン
                </button>
              </>
            )}
          </div>
        </nav>

        <div style={{
          marginTop: "auto",
          padding: "16px 24px",
          fontSize: "11px",
          color: "rgba(255,255,255,0.3)",
          lineHeight: 1.6,
        }}>
          当サイトはアフィリエイト広告を含みます。<br />
          &copy; {new Date().getFullYear()} AV Shorts
        </div>
      </div>
    </>
  );
}
