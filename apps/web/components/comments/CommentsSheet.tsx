"use client";

/**
 * YouTube 風コメントシート。フィードのサイドアクション (ブックマークの直下) から開く。
 *
 * 仕様:
 *  - 表示は 2 段スレッド (root + 返信)。さらに深い返信は許可しない。
 *  - 投稿はログイン必須。ボタンを押すと next-auth.signIn() に流す。
 *  - 表示名はサーバ側 (User.display_name) を SoT とする。未設定なら「名無しのユーザー」。
 *  - 自分のコメントだけ削除アイコンを出す。
 *  - 投稿の即時反映は楽観更新 (サーバ応答が来たら ID を差し替え)。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { signIn, useSession } from "next-auth/react";

import {
  type CommentItem,
  createComment,
  deleteComment,
  listComments,
} from "@/lib/api/comments";

const DEFAULT_DISPLAY_NAME = "名無しのユーザー";

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
  const { data: session, status } = useSession();
  const myUserId = (session as { userId?: string } | null)?.userId ?? null;
  const isAuthenticated = status === "authenticated";

  const [items, setItems] = useState<CommentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<CommentItem | null>(null);
  const [posting, setPosting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  // open 中は body スクロールを止める。
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // 返信モードに入ったら textarea へフォーカス。
  useEffect(() => {
    if (replyTo && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [replyTo]);

  const handlePost = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (!isAuthenticated) {
      signIn("twitter", { callbackUrl: window.location.href });
      return;
    }
    setPosting(true);
    const parentId = replyTo ? replyTo.id : null;
    const created = await createComment(slug, trimmed, parentId);
    setPosting(false);
    if (!created) {
      // 失敗は素朴に alert (アプリ内 toast は未導入)。
      alert("コメントの投稿に失敗しました");
      return;
    }
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
  }, [body, isAuthenticated, replyTo, slug, total, onCountChange]);

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
      onClick={onClose}
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
        onClick={(e) => e.stopPropagation()}
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
              placeholder={
                isAuthenticated
                  ? "コメントを書く..."
                  : "ログインしてコメントしましょう"
              }
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
              disabled={posting || (isAuthenticated && body.trim().length === 0)}
              style={{
                background: "#e91e63",
                color: "#fff",
                border: "none",
                borderRadius: 10,
                padding: "0 14px",
                fontWeight: 700,
                cursor: "pointer",
                opacity:
                  posting || (isAuthenticated && body.trim().length === 0)
                    ? 0.5
                    : 1,
              }}
            >
              {isAuthenticated ? (posting ? "送信中" : "送信") : "ログイン"}
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
  return (
    <div style={{ padding: "10px 4px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
      <CommentBubble
        comment={comment}
        isMine={isMine}
        showReplyButton
        onReply={onReply}
        onDelete={onDelete}
      />
      {comment.replies.length > 0 && (
        <div style={{ marginTop: 8, paddingLeft: 28 }}>
          {comment.replies.map((r) => {
            const replyIsMine =
              !!myUserId && r.author_user_id === myUserId;
            return (
              <CommentBubble
                key={r.id}
                comment={r}
                isMine={replyIsMine}
                showReplyButton={false}
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
  showReplyButton: boolean;
  onReply?: (target: CommentItem) => void;
  onDelete: (target: CommentItem) => void;
}

function CommentBubble({
  comment,
  isMine,
  showReplyButton,
  onReply,
  onDelete,
}: CommentBubbleProps) {
  return (
    <div style={{ padding: "6px 0" }}>
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
      <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
        {showReplyButton && onReply && (
          <button
            type="button"
            onClick={() => onReply(comment)}
            style={{
              background: "transparent",
              color: "#bbb",
              border: "none",
              fontSize: 12,
              cursor: "pointer",
              padding: 0,
            }}
          >
            返信
          </button>
        )}
        {isMine && (
          <button
            type="button"
            onClick={() => onDelete(comment)}
            style={{
              background: "transparent",
              color: "#bbb",
              border: "none",
              fontSize: 12,
              cursor: "pointer",
              padding: 0,
            }}
          >
            削除
          </button>
        )}
      </div>
    </div>
  );
}
