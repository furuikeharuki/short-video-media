"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signIn, signOut, useSession } from "next-auth/react";
import { markFeedStartUnmuted } from "@/lib/feedNav";
import { buildFeedHrefFromSavedPref } from "@/lib/savedSearchPrefs";
import { writeBottomNavFreezeSnapshot } from "@/lib/bottomNavFreeze";
import { getDisplayName, putDisplayName } from "@/lib/api/comments";

// /feed (フィード上モーダル経由で /movies/<slug> になっているケースも含む) から
// ハンバーガー経由で別ルートへ遷移する瞬間、ヘッダーとボトムナビの間だけ
// 黒+スピナーで覆って体感遅延を消す。BottomNav と同じ仕組み。
function dispatchNavLoadingShow() {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event("nav-loading-show"));
  } catch {
    /* ignore */
  }
}

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
  const pathname = usePathname();
  // 表示名 (コメント機能で使う公開名)。サーバ側 (User.display_name) を SoT として
  // 取得する。未ログイン or 未設定なら「名無しのユーザー」。
  const [displayName, setDisplayName] = useState<string>("名無しのユーザー");
  const [editingName, setEditingName] = useState<string>("");
  const [nameStatus, setNameStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  // ドロワーを開いた瞬間に表示名を再取得する (別タブで変更されていた場合に追従)。
  useEffect(() => {
    if (!open) return;
    if (status !== "authenticated") {
      setDisplayName("名無しのユーザー");
      setEditingName("");
      return;
    }
    let cancelled = false;
    void (async () => {
      const name = await getDisplayName();
      if (cancelled) return;
      setDisplayName(name);
      setEditingName(name === "名無しのユーザー" ? "" : name);
      setNameStatus("idle");
    })();
    return () => {
      cancelled = true;
    };
  }, [open, status]);

  const saveDisplayName = async () => {
    setNameStatus("saving");
    const next = editingName.trim();
    const saved = await putDisplayName(next === "" ? null : next);
    if (saved == null) {
      setNameStatus("error");
      return;
    }
    setDisplayName(saved);
    setEditingName(saved === "名無しのユーザー" ? "" : saved);
    setNameStatus("saved");
    // 2 秒で `saved` 表示を消す。
    setTimeout(() => setNameStatus("idle"), 2000);
  };
  // /feed および /search/feed、フィード上で開く /movies/<slug> モーダル中まで含めて
  // 「ショート視聴中」とみなす。BottomNav の onShortFeed と揃える。
  const onShortFeed =
    pathname === "/feed" ||
    pathname.startsWith("/search/feed") ||
    pathname.startsWith("/movies/");
  // 着地ページの BottomNav が first paint で「離脱直前の見た目」を維持するための
  // active href スナップショット。BottomNav の currentActiveHref と同じ法則。
  const bottomNavActiveHref = onShortFeed
    ? "/feed"
    : pathname === "/"
      ? "/"
      : pathname.startsWith("/mypage")
        ? "/mypage"
        : pathname;

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
                  // /feed (ショート) からの離脱はオーバーレイを即時表示する。
                  // SPA/フルページのどちらでもタップ直後に黒+スピナーが上下バー以外を
                  // 覆い、「タップが効いていない」体感を消す。SPA の場合は
                  // NavigationLoadingOverlay 側で pathname 変更を検知して自動で消える。
                  if (onShortFeed && !goingToFeed) {
                    writeBottomNavFreezeSnapshot(bottomNavActiveHref);
                    dispatchNavLoadingShow();
                  }
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
                      writeBottomNavFreezeSnapshot(bottomNavActiveHref);
                      dispatchNavLoadingShow();
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

          {/* 表示名エディタ (ログイン中のみ表示) */}
          {status === "authenticated" && (
            <div
              style={{
                padding: "12px 24px 8px",
                borderTop: "1px solid rgba(255,255,255,0.08)",
                marginTop: "8px",
              }}
            >
              <label
                style={{
                  display: "block",
                  fontSize: "12px",
                  color: "rgba(255,255,255,0.7)",
                  marginBottom: "6px",
                }}
              >
                コメントで使う表示名
              </label>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="text"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  placeholder="名無しのユーザー"
                  maxLength={32}
                  style={{
                    flex: 1,
                    background: "#1a1a1a",
                    color: "#fff",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: "8px",
                    padding: "8px 10px",
                    fontSize: "13px",
                    fontFamily: "inherit",
                  }}
                />
                <button
                  type="button"
                  onClick={saveDisplayName}
                  disabled={nameStatus === "saving"}
                  style={{
                    background: "#e91e63",
                    color: "#fff",
                    border: "none",
                    borderRadius: "8px",
                    padding: "0 12px",
                    fontSize: "13px",
                    fontWeight: 700,
                    cursor: "pointer",
                    opacity: nameStatus === "saving" ? 0.5 : 1,
                  }}
                >
                  保存
                </button>
              </div>
              <div
                style={{
                  fontSize: "11px",
                  color: "rgba(255,255,255,0.5)",
                  marginTop: "6px",
                  minHeight: "14px",
                }}
              >
                {nameStatus === "saving"
                  ? "保存中..."
                  : nameStatus === "saved"
                    ? "保存しました"
                    : nameStatus === "error"
                      ? "保存に失敗しました"
                      : `現在の表示名: ${displayName}`}
              </div>
            </div>
          )}

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
          {/*
            SSR は UTC タイムゾーンで動くため、年末の数時間 (UTC 12/31 15:00–24:00
            = JST 1/1 00:00–09:00 等) はサーバとクライアントで getFullYear() が
            食い違い、root layout 経由でレンダーされる本コンポーネントが
            React error #418 (text content does not match server-rendered HTML)
            の発生源になる。年表示自体は SEO 要件もないクライアント文言なので、
            suppressHydrationWarning で動的部分だけ差分を許容する。
          */}
          &copy; <span suppressHydrationWarning>{new Date().getFullYear()}</span> AV Shorts
        </div>
      </div>
    </>
  );
}
