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

// 表示名のクライアントキャッシュキー。ドロワーを開いた瞬間にサーバ取得が
// 終わっていない場合でも、前回取得値を即時に出して flicker を防ぐ。
const DISPLAY_NAME_CACHE_KEY = "hm:displayName:v1";
const DEFAULT_DISPLAY_NAME = "名無しのユーザー";

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
  // null = 未取得 (ローディング)。flicker 防止のため、取得完了までは fallback を出さない。
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string>("");
  const [nameStatus, setNameStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // 「アカウント名」項目から開く編集モーダル。
  const [nameModalOpen, setNameModalOpen] = useState(false);

  // ドロワーを開いた瞬間に表示名を再取得する (別タブで変更されていた場合に追従)。
  // 取得が走っている間は前回取得値 (localStorage キャッシュ) を出して flicker を消す。
  // キャッシュが無い場合だけ短時間スケルトンを出す。
  useEffect(() => {
    if (!open) return;
    if (status !== "authenticated") {
      setDisplayName(DEFAULT_DISPLAY_NAME);
      setEditingName("");
      return;
    }
    // 先に localStorage のキャッシュを反映 (前回値を即時に出す)。
    if (typeof window !== "undefined") {
      try {
        const cached = window.localStorage.getItem(DISPLAY_NAME_CACHE_KEY);
        if (cached != null) {
          setDisplayName(cached);
          setEditingName(cached === DEFAULT_DISPLAY_NAME ? "" : cached);
        }
      } catch {
        /* ignore */
      }
    }
    let cancelled = false;
    void (async () => {
      const name = await getDisplayName();
      if (cancelled) return;
      setDisplayName(name);
      setEditingName(name === DEFAULT_DISPLAY_NAME ? "" : name);
      setNameStatus("idle");
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(DISPLAY_NAME_CACHE_KEY, name);
        } catch {
          /* ignore */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, status]);

  // モーダルを開く時に「現在の表示名」をプリフィルする (未設定なら「名無しのユーザー」)。
  const openNameModal = () => {
    setEditingName(displayName || DEFAULT_DISPLAY_NAME);
    setNameStatus("idle");
    setNameModalOpen(true);
  };

  const saveDisplayName = async () => {
    setNameStatus("saving");
    const next = editingName.trim();
    const saved = await putDisplayName(next === "" ? null : next);
    if (saved == null) {
      setNameStatus("error");
      return;
    }
    setDisplayName(saved);
    setEditingName(saved);
    setNameStatus("saved");
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(DISPLAY_NAME_CACHE_KEY, saved);
      } catch {
        /* ignore */
      }
    }
    // 保存に成功したら少し待ってモーダルを閉じる。
    setTimeout(() => {
      setNameStatus("idle");
      setNameModalOpen(false);
    }, 600);
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
    // アカウント名モーダルが上に乗っている間は drawer の outside-close を止める
    // (モーダルの overlay は drawer の外側に描画されるため、そのままだと
    // モーダル背景タップで drawer も閉じてしまう)。
    if (nameModalOpen) return;
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
  }, [open, nameModalOpen]);

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
          {/* アカウント名 (ログイン中のみ表示)。タップで編集モーダルを開く。 */}
          {status === "authenticated" && (
            <button
              type="button"
              onClick={openNameModal}
              style={{
                display: "block",
                width: "100%",
                padding: "14px 24px",
                background: "transparent",
                color: "#fff",
                fontSize: "15px",
                fontWeight: 500,
                border: "none",
                borderBottom: "1px solid rgba(255,255,255,0.06)",
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "inherit",
              }}
            >
              アカウント名
              {displayName == null ? (
                // 取得完了前。fallback「名無しのユーザー」を一瞬出して上書きされる
                // flicker を避けるため、スケルトンで領域だけ確保する。
                <span
                  aria-hidden="true"
                  style={{
                    display: "block",
                    marginTop: "6px",
                    width: "120px",
                    height: "12px",
                    borderRadius: "4px",
                    background: "rgba(255,255,255,0.08)",
                  }}
                />
              ) : (
                <span
                  style={{
                    display: "block",
                    fontSize: "12px",
                    color: "rgba(255,255,255,0.55)",
                    marginTop: "2px",
                  }}
                >
                  {displayName}
                </span>
              )}
            </button>
          )}
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

      {/* アカウント名 編集モーダル */}
      {nameModalOpen && status === "authenticated" && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="アカウント名"
          onClick={() => {
            if (nameStatus !== "saving") setNameModalOpen(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.65)",
            zIndex: 200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 360,
              background: "#1a1a1a",
              color: "#fff",
              borderRadius: 12,
              padding: "20px",
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <div style={{ fontSize: "16px", fontWeight: 700, marginBottom: "12px" }}>
              アカウント名
            </div>
            <div
              style={{
                fontSize: "12px",
                color: "rgba(255,255,255,0.6)",
                marginBottom: "10px",
              }}
            >
              コメントで使う表示名を編集できます。
            </div>
            <input
              type="text"
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              placeholder="名無しのユーザー"
              maxLength={32}
              autoFocus
              style={{
                display: "block",
                width: "100%",
                background: "#0c0c0c",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: "8px",
                padding: "10px 12px",
                fontSize: "14px",
                fontFamily: "inherit",
                boxSizing: "border-box",
              }}
            />
            <div
              style={{
                fontSize: "11px",
                color:
                  nameStatus === "error"
                    ? "#ff6b6b"
                    : "rgba(255,255,255,0.5)",
                marginTop: "8px",
                minHeight: "14px",
              }}
            >
              {nameStatus === "saving"
                ? "保存中..."
                : nameStatus === "saved"
                  ? "保存しました"
                  : nameStatus === "error"
                    ? "保存に失敗しました"
                    : "空のままにすると「名無しのユーザー」に戻ります。"}
            </div>
            <div
              style={{
                display: "flex",
                gap: 8,
                marginTop: "16px",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                onClick={() => setNameModalOpen(false)}
                disabled={nameStatus === "saving"}
                style={{
                  background: "transparent",
                  color: "#fff",
                  border: "1px solid rgba(255,255,255,0.2)",
                  borderRadius: "8px",
                  padding: "8px 14px",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: "pointer",
                  opacity: nameStatus === "saving" ? 0.5 : 1,
                }}
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={saveDisplayName}
                disabled={nameStatus === "saving"}
                style={{
                  background: "#e91e63",
                  color: "#fff",
                  border: "none",
                  borderRadius: "8px",
                  padding: "8px 14px",
                  fontSize: "13px",
                  fontWeight: 700,
                  cursor: "pointer",
                  opacity: nameStatus === "saving" ? 0.5 : 1,
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
