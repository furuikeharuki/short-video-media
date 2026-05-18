/**
 * /api/v1/me/* (ブックマーク・視聴履歴) を叩くクライアント側ラッパー。
 *
 * Next.js のクライアントコンポーネントから呼ぶ場合は
 * 同じ Next.js 上の /api/proxy/me/* を経由する (Cookie セッションから JWT を取り出して
 * Authorization ヘッダーに付与するため)。
 */

import type { MovieCard } from "@/lib/api/feed";

export type BookmarkItem = {
  movie: MovieCard;
  created_at: string;
};

export type ViewItem = {
  movie: MovieCard;
  last_viewed_at: string;
  view_count: number;
};

/** ログイン中ユーザーのブックマーク一覧 */
export async function getBookmarks(opts?: {
  limit?: number;
  offset?: number;
}): Promise<BookmarkItem[]> {
  const url = new URL("/api/proxy/me/bookmarks", window.location.origin);
  if (opts?.limit) url.searchParams.set("limit", String(opts.limit));
  if (opts?.offset) url.searchParams.set("offset", String(opts.offset));
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) return [];
  const data = (await res.json()) as { items: BookmarkItem[] };
  return data.items;
}

/** ログイン中ユーザーのブックマーク movie_id 一覧 */
export async function getBookmarkIds(): Promise<string[]> {
  const res = await fetch("/api/proxy/me/bookmarks/ids", { cache: "no-store" });
  if (!res.ok) return [];
  return (await res.json()) as string[];
}

export async function addBookmark(movieId: string): Promise<boolean> {
  const res = await fetch("/api/proxy/me/bookmarks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ movie_id: movieId }),
  });
  return res.ok;
}

export async function removeBookmark(movieId: string): Promise<boolean> {
  const res = await fetch("/api/proxy/me/bookmarks", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ movie_id: movieId }),
  });
  return res.ok;
}

/** 視聴履歴を1件記録 (fire-and-forget でも OK) */
export async function recordView(movieId: string): Promise<void> {
  try {
    await fetch("/api/proxy/me/views", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ movie_id: movieId }),
      keepalive: true,
    });
  } catch {
    /* ignore */
  }
}

export async function getViews(opts?: {
  limit?: number;
  offset?: number;
}): Promise<ViewItem[]> {
  const url = new URL("/api/proxy/me/views", window.location.origin);
  if (opts?.limit) url.searchParams.set("limit", String(opts.limit));
  if (opts?.offset) url.searchParams.set("offset", String(opts.offset));
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) return [];
  const data = (await res.json()) as { items: ViewItem[] };
  return data.items;
}

/**
 * サーバ保存された NG ワード一覧を取得。
 * 未ログイン (401) は空配列を返し、UI をローカル限定モードにフォールバックさせる。
 */
export async function getNgWords(): Promise<string[]> {
  try {
    const res = await fetch("/api/proxy/me/ng-words", { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as { words: string[] };
    return Array.isArray(data.words) ? data.words : [];
  } catch {
    return [];
  }
}

/**
 * NG ワードを全置換で保存する。
 * 401/500 等で失敗したら false、成功なら true。
 */
export async function putNgWords(words: string[]): Promise<boolean> {
  try {
    const res = await fetch("/api/proxy/me/ng-words", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ words }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 「最後に適用した検索条件」の永続化用ペイロード。
 * API 側 SearchPrefPayload と一致。NG ワードも一緒にここで保存する。
 * (旧 /me/ng-words エンドポイントとは独立。`PUT /me/search-prefs` 一発で全置換)
 */
export type SearchPrefPayload = {
  q?: string | null;
  genres?: string[] | null;
  actresses?: string[] | null;
  series_list?: string[] | null;
  directors?: string[] | null;
  makers?: string[] | null;
  labels?: string[] | null;
  ng_words?: string[] | null;
  date_from?: string | null;
  date_to?: string | null;
  sort?: string | null;
};

/**
 * ログイン中ユーザーの「最後に適用した検索条件」を取得。
 * 401/未保存ならすべて null/空のオブジェクトを返す。
 */
export async function getSearchPref(): Promise<SearchPrefPayload> {
  try {
    const res = await fetch("/api/proxy/me/search-prefs", { cache: "no-store" });
    if (!res.ok) return {};
    return (await res.json()) as SearchPrefPayload;
  } catch {
    return {};
  }
}

/** 検索条件を全置換で保存。失敗時 false。 */
export async function putSearchPref(payload: SearchPrefPayload): Promise<boolean> {
  try {
    const res = await fetch("/api/proxy/me/search-prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}
