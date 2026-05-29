/**
 * /api/v1/movies/{slug}/comments と /api/v1/me/display-name を叩く
 * クライアント側ラッパー。
 *
 * - GET は公開エンドポイント (NEXT_PUBLIC_API_BASE_URL を直接叩く)
 * - POST / DELETE / display-name の GET/PUT は /api/proxy/me 経由 (Cookie → JWT 付け替え)
 *
 * 既存の lib/api/me.ts と同じ規約で組み立てる。
 */

export type CommentItem = {
  id: string;
  parent_id: string | null;
  author_user_id: string | null;
  display_name: string;
  body: string;
  created_at: string;
  replies: CommentItem[];
};

export type CommentListResponse = {
  items: CommentItem[];
  total: number;
};

const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? ""
).replace(/\/+$/, "");

const DEFAULT_DISPLAY_NAME = "名無しのユーザー";

/**
 * 作品のコメント一覧を取得。公開エンドポイントなので未ログインでも見える。
 */
export async function listComments(
  slug: string,
  opts?: { limit?: number; offset?: number },
): Promise<CommentListResponse> {
  if (!API_BASE_URL || !slug) return { items: [], total: 0 };
  const url = new URL(
    `${API_BASE_URL}/api/v1/movies/${encodeURIComponent(slug)}/comments`,
  );
  if (opts?.limit) url.searchParams.set("limit", String(opts.limit));
  if (opts?.offset) url.searchParams.set("offset", String(opts.offset));
  try {
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) return { items: [], total: 0 };
    return (await res.json()) as CommentListResponse;
  } catch {
    return { items: [], total: 0 };
  }
}

/**
 * コメント or 返信を投稿。/api/proxy/comments 経由でサーバ側 JWT を付ける。
 * 401/失敗時は null。
 */
export async function createComment(
  slug: string,
  body: string,
  parent_id: string | null = null,
): Promise<CommentItem | null> {
  try {
    const res = await fetch(
      `/api/proxy/comments/${encodeURIComponent(slug)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, parent_id }),
      },
    );
    if (!res.ok) return null;
    return (await res.json()) as CommentItem;
  } catch {
    return null;
  }
}

/** 自分のコメントを削除。返信ぶら下がりは backend 側で ON DELETE CASCADE。 */
export async function deleteComment(commentId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `/api/proxy/comments/by-id/${encodeURIComponent(commentId)}`,
      { method: "DELETE" },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** ログイン中ユーザーの表示名を取得。未ログインでも fallback で「名無しのユーザー」。 */
export async function getDisplayName(): Promise<string> {
  try {
    const res = await fetch("/api/proxy/me/display-name", {
      cache: "no-store",
    });
    if (!res.ok) return DEFAULT_DISPLAY_NAME;
    const data = (await res.json()) as { display_name?: string };
    return (data.display_name ?? DEFAULT_DISPLAY_NAME) || DEFAULT_DISPLAY_NAME;
  } catch {
    return DEFAULT_DISPLAY_NAME;
  }
}

/** 表示名を更新。空文字を渡すと「名無しのユーザー」にリセット。 */
export async function putDisplayName(
  displayName: string | null,
): Promise<string | null> {
  try {
    const res = await fetch("/api/proxy/me/display-name", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: displayName }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { display_name?: string };
    return data.display_name ?? null;
  } catch {
    return null;
  }
}
