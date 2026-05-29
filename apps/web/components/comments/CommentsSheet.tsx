"use client";

/**
 * YouTube 風コメントシート。フィードのサイドアクション (ブックマークの直下) から開く。
 *
 * 仕様:
 *  - 表示は 2 段スレッド (root + 返信)。さらに深い返信は許可しない。
 *  - 投稿はログイン必須。ボタンを押すと next-auth.signIn() に流す。
 *  - 表示名はサーバ側 (User.display_name) を SoT とする。未設定なら「名無しのユーザー」。
 *  - 返信はコメント本体をタップして開始する。削除は右上の縦三点メニューから。
 *  - 投稿の即時反映は楽観更新 (サーバ応答が来たら ID を差し替え)。
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSession } from "next-auth/react";

import {
  type CommentItem,
  createComment,
  deleteComment,
  listComments,
} from "@/lib/api/comments";

const DEFAULT_DISPLAY_NAME = "名無しのユーザー";

// シートを閉じるためのスワイプ判定。リスト先頭で下方向に
// SWIPE_CLOSE_THRESHOLD_PX 以上引っ張られたら閉じる。
// 横方向の方が大きい (テキスト選択や横スクロール) の場合は無視する。
const SWIPE_CLOSE_THRESHOLD_PX = 80;

interface Props {
  slug: string;
  open: boolean;
  onClose: () => void;
  /** ヘッダーに件数を反映するためにシート外側から件数 setter を渡す。 */
  onCountChange?: (count: number) => void;
}

function formatDateTime(iso: string): string {
  // 例: 2026/05/29 14:32
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}/${m}/${day} ${hh}:${mm}`;
}

export default function CommentsSheet({
  slug,
  open,
  onClose,
  onCountChange,
}: Props) {
  const { data: session } = useSession();
  const myUserId = (session as { userId?: string } | null)?.userId ?? null;

  const [items, setItems] = useState<CommentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<CommentItem | null>(null);
  const [posting, setPosting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // スクロール領域とドラッグ判定。先頭で下に引っ張ったときのみ閉じる。
  const scrollRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragStartYRef = useRef<number | null>(null);
  const dragStartXRef = useRef<number | null>(null);
  const dragDyRef = useRef(0);
  const dragActiveRef = useRef(false);
  // popstate / cleanup から常に最新の onClose を呼ぶための ref。
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // open ↔ slug 変更で fetch する。slug が同じならキャッシュは持たず必ず取り直し。
  useEffect(() => {
    if (!open || !slug) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const res = await listComments(slug, { limit: 100 });
      if (cancelled) return;
      setItems(res.items);
      setTotal(res.total);
      onCountChange?.(res.total);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, slug, onCountChange]);

  // open 中は body スクロールを止める。加えて modal-open / modal-close を発火して
  // FeedViewer 側のスワイプ判定を抑止する (シート上でのタッチがフィードに伝搬しない)。
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    try {
      window.dispatchEvent(new Event("modal-open"));
    } catch {
      /* ignore */
    }
    return () => {
      document.body.style.overflow = prev;
      try {
        window.dispatchEvent(new Event("modal-close"));
      } catch {
        /* ignore */
      }
    };
  }, [open]);

  // 返信モードに入ったら textarea へフォーカス。
  useEffect(() => {
    if (replyTo && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [replyTo]);

  // ブラウザバックでシートを閉じる。MovieDetailModal と同じ pushState/popstate 方式:
  //   - open になった瞬間に sentinel state を push。
  //   - popstate が来たら onClose を呼ぶ (URL は既に巻き戻っているので何もしない)。
  //   - ✕ / 動画切替 / 上端スワイプで閉じた場合は cleanup で history.back() を呼んで
  //     push した sentinel を消す。これで URL バーが残らない。
  useEffect(() => {
    if (!open) return;
    if (typeof window === "undefined") return;
    let poppedByUser = false;
    try {
      window.history.pushState({ commentsSheet: true }, "");
    } catch {
      /* ignore */
    }
    const onPop = () => {
      poppedByUser = true;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (!poppedByUser) {
        try {
          const st = window.history.state as { commentsSheet?: boolean } | null;
          if (st && st.commentsSheet) {
            window.history.back();
          }
        } catch {
          /* ignore */
        }
      }
    };
  }, [open]);

  // スクロール先頭で下方向にスワイプされたときだけ閉じる。
  //   - touchstart 時点で scrollRef.scrollTop === 0 のときだけドラッグ判定を開始。
  //   - 横スクロール / 横スワイプが優位な場合は無視。
  //   - 中身を上にスクロールしている (scrollTop > 0) 状態では一切閉じない。
  const handleListTouchStart = useCallback((e: ReactTouchEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop > 0) {
      dragActiveRef.current = false;
      dragStartYRef.current = null;
      dragStartXRef.current = null;
      return;
    }
    const t = e.touches[0];
    dragStartYRef.current = t.clientY;
    dragStartXRef.current = t.clientX;
    dragDyRef.current = 0;
    dragActiveRef.current = true;
  }, []);

  const handleListTouchMove = useCallback((e: ReactTouchEvent<HTMLDivElement>) => {
    if (!dragActiveRef.current) return;
    if (dragStartYRef.current == null || dragStartXRef.current == null) return;
    const t = e.touches[0];
    const dy = t.clientY - dragStartYRef.current;
    const dx = t.clientX - dragStartXRef.current;
    // 横方向の方が大きい動きは横スクロール / 単なるタップずれとして扱い、close 判定から外す。
    if (Math.abs(dx) > Math.abs(dy) + 4) {
      dragActiveRef.current = false;
      if (sheetRef.current) {
        sheetRef.current.style.transition = "";
        sheetRef.current.style.transform = "";
      }
      return;
    }
    // 上方向にスワイプしたら閉じない (通常のリストスクロール扱い)。
    if (dy <= 0) {
      dragDyRef.current = 0;
      if (sheetRef.current) {
        sheetRef.current.style.transform = "";
      }
      return;
    }
    dragDyRef.current = dy;
    if (sheetRef.current) {
      sheetRef.current.style.transform = `translateY(${dy}px)`;
      sheetRef.current.style.transition = "none";
    }
  }, []);

  const handleListTouchEnd = useCallback(() => {
    const dy = dragDyRef.current;
    const wasActive = dragActiveRef.current;
    dragActiveRef.current = false;
    dragStartYRef.current = null;
    dragStartXRef.current = null;
    dragDyRef.current = 0;
    if (sheetRef.current) {
      sheetRef.current.style.transition = "";
      sheetRef.current.style.transform = "";
    }
    if (wasActive && dy >= SWIPE_CLOSE_THRESHOLD_PX) {
      onClose();
    }
  }, [onClose]);

  const handlePost = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    // 未ログインでも「名無しのユーザー」として投稿できる (サーバ側で snapshot を補完)。
    setPosting(true);
    const parentId = replyTo ? replyTo.id : null;
    const result = await createComment(slug, trimmed, parentId);
    setPosting(false);
    if (!result.ok) {
      // 失敗は素朴に alert (アプリ内 toast は未導入)。
      const msg =
        result.reason === "rate_limited"
          ? "投稿の間隔が短すぎるか、同じ内容を連続で送信しています。少し時間をおいて試してください。"
          : result.reason === "rejected"
            ? "コメントを送信できませんでした (内容が許可されていません)。"
            : "コメントの投稿に失敗しました";
      alert(msg);
      return;
    }
    const created = result.item;
    if (parentId) {
      setItems((prev) =>
        prev.map((c) =>
          c.id === parentId ? { ...c, replies: [...c.replies, created] } : c,
        ),
      );
    } else {
      // 新着 root を先頭に積む。total も増やす。
      setItems((prev) => [created, ...prev]);
      setTotal((n) => n + 1);
      onCountChange?.(total + 1);
    }
    setBody("");
    setReplyTo(null);
  }, [body, replyTo, slug, total, onCountChange]);

  const handleDelete = useCallback(
    async (target: CommentItem) => {
      if (!confirm("このコメントを削除します。よろしいですか？")) return;
      const ok = await deleteComment(target.id);
      if (!ok) {
        alert("削除に失敗しました");
        return;
      }
      if (target.parent_id) {
        // 返信を削除。
        setItems((prev) =>
          prev.map((c) =>
            c.id === target.parent_id
              ? {
                  ...c,
                  replies: c.replies.filter((r) => r.id !== target.id),
                }
              : c,
          ),
        );
      } else {
        // root を削除。total も減らす (返信も連動して消える)。
        setItems((prev) => prev.filter((c) => c.id !== target.id));
        setTotal((n) => Math.max(0, n - 1));
        onCountChange?.(Math.max(0, total - 1));
      }
    },
    [total, onCountChange],
  );

  const replyTargetLabel = useMemo(() => {
    if (!replyTo) return null;
    const name = replyTo.display_name || DEFAULT_DISPLAY_NAME;
    return `@${name} に返信`;
  }, [replyTo]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="コメント"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 9999,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      <div
        ref={sheetRef}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
        onTouchEnd={(e) => e.stopPropagation()}
        onTouchCancel={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 640,
          height: "75vh",
          background: "#111",
          color: "#fff",
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* ヘッダー */}
        <div
          style={{
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <strong style={{ fontSize: 15 }}>コメント {total}</strong>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            style={{
              background: "transparent",
              border: "none",
              color: "#fff",
              cursor: "pointer",
              padding: 4,
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <line x1="4" y1="4" x2="20" y2="20" />
              <line x1="20" y1="4" x2="4" y2="20" />
            </svg>
          </button>
        </div>

        {/* リスト */}
        <div
          ref={scrollRef}
          onTouchStart={handleListTouchStart}
          onTouchMove={handleListTouchMove}
          onTouchEnd={handleListTouchEnd}
          onTouchCancel={handleListTouchEnd}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "8px 12px 12px",
          }}
        >
          {loading ? (
            <div style={{ padding: 24, textAlign: "center", color: "#888" }}>
              読み込み中...
            </div>
          ) : items.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "#888" }}>
              まだコメントはありません。最初に書いてみましょう。
            </div>
          ) : (
            items.map((c) => (
              <CommentRow
                key={c.id}
                comment={c}
                myUserId={myUserId}
                onReply={(target) => setReplyTo(target)}
                onDelete={handleDelete}
              />
            ))
          )}
        </div>

        {/* 入力エリア */}
        <div
          style={{
            borderTop: "1px solid rgba(255,255,255,0.08)",
            padding: "10px 12px 14px",
            background: "#0c0c0c",
          }}
        >
          {replyTargetLabel && (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 6,
                fontSize: 12,
                color: "#bbb",
              }}
            >
              <span>{replyTargetLabel}</span>
              <button
                type="button"
                onClick={() => setReplyTo(null)}
                style={{
                  background: "transparent",
                  color: "#bbb",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12,
                  textDecoration: "underline",
                }}
              >
                返信をやめる
              </button>
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <textarea
              ref={textareaRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="コメントを書く..."
              rows={2}
              maxLength={2000}
              style={{
                flex: 1,
                resize: "none",
                background: "#1a1a1a",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 10,
                padding: "8px 10px",
                fontSize: 14,
                lineHeight: 1.4,
                fontFamily: "inherit",
              }}
            />
            <button
              type="button"
              onClick={handlePost}
              disabled={posting || body.trim().length === 0}
              style={{
                background: "#e91e63",
                color: "#fff",
                border: "none",
                borderRadius: 10,
                padding: "0 14px",
                fontWeight: 700,
                cursor: "pointer",
                opacity: posting || body.trim().length === 0 ? 0.5 : 1,
              }}
            >
              {posting ? "送信中" : "送信"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface CommentRowProps {
  comment: CommentItem;
  myUserId: string | null;
  onReply: (target: CommentItem) => void;
  onDelete: (target: CommentItem) => void;
}

function CommentRow({
  comment,
  myUserId,
  onReply,
  onDelete,
}: CommentRowProps) {
  const isMine =
    !!myUserId && comment.author_user_id === myUserId;
  // 返信は初期状態で折りたたみ。展開トグルは bubble の左下に置く。
  const [repliesOpen, setRepliesOpen] = useState(false);
  const replyCount = comment.replies.length;
  return (
    <div style={{ padding: "10px 4px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
      <CommentBubble
        comment={comment}
        isMine={isMine}
        canReply
        onReply={onReply}
        onDelete={onDelete}
        footer={
          replyCount > 0 ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setRepliesOpen((v) => !v);
              }}
              aria-expanded={repliesOpen}
              style={{
                background: "transparent",
                color: "#7eb6ff",
                border: "none",
                fontSize: 12,
                cursor: "pointer",
                padding: "4px 0",
              }}
            >
              {repliesOpen ? `返信を隠す` : `${replyCount}件の返信を表示`}
            </button>
          ) : null
        }
      />
      {replyCount > 0 && repliesOpen && (
        <div style={{ marginTop: 4, paddingLeft: 28 }}>
          {comment.replies.map((r) => {
            const replyIsMine =
              !!myUserId && r.author_user_id === myUserId;
            return (
              <CommentBubble
                key={r.id}
                comment={r}
                isMine={replyIsMine}
                canReply={false}
                onDelete={onDelete}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

interface CommentBubbleProps {
  comment: CommentItem;
  isMine: boolean;
  /** true のとき bubble タップで返信開始。返信 (子) は false。 */
  canReply: boolean;
  onReply?: (target: CommentItem) => void;
  onDelete: (target: CommentItem) => void;
  /** bubble 下部に並べる補助要素 (例: 「○件の返信を表示」)。 */
  footer?: ReactNode;
}

function CommentBubble({
  comment,
  isMine,
  canReply,
  onReply,
  onDelete,
  footer,
}: CommentBubbleProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 外側タップでメニューを閉じる。
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [menuOpen]);

  const handleBodyTap = () => {
    if (canReply && onReply) onReply(comment);
  };

  const handleBodyKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!canReply || !onReply) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onReply(comment);
    }
  };

  return (
    <div style={{ position: "relative", padding: "6px 0" }}>
      <div
        role={canReply ? "button" : undefined}
        tabIndex={canReply ? 0 : undefined}
        aria-label={canReply ? "このコメントに返信" : undefined}
        onClick={canReply ? handleBodyTap : undefined}
        onKeyDown={canReply ? handleBodyKey : undefined}
        style={{
          cursor: canReply ? "pointer" : "default",
          // 右上の三点メニューと重ならないよう右側に余白。
          paddingRight: 28,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            marginBottom: 4,
          }}
        >
          <strong style={{ fontSize: 13 }}>
            {comment.display_name || DEFAULT_DISPLAY_NAME}
          </strong>
          <span style={{ fontSize: 11, color: "#888" }}>
            {formatDateTime(comment.created_at)}
          </span>
        </div>
        <div
          style={{
            fontSize: 14,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {comment.body}
        </div>
        {footer && <div style={{ marginTop: 6 }}>{footer}</div>}
      </div>
      {isMine && (
        <div
          ref={menuRef}
          style={{ position: "absolute", top: 4, right: 0 }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            aria-label="コメントメニュー"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            style={{
              background: "transparent",
              border: "none",
              color: "#bbb",
              cursor: "pointer",
              padding: 4,
              lineHeight: 0,
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <circle cx="12" cy="5" r="1.8" />
              <circle cx="12" cy="12" r="1.8" />
              <circle cx="12" cy="19" r="1.8" />
            </svg>
          </button>
          {menuOpen && (
            <div
              role="menu"
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                marginTop: 4,
                background: "#1a1a1a",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 8,
                minWidth: 120,
                boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
                zIndex: 1,
              }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onDelete(comment);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background: "transparent",
                  color: "#ff6b6b",
                  border: "none",
                  cursor: "pointer",
                  padding: "10px 14px",
                  fontSize: 13,
                }}
              >
                削除
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
