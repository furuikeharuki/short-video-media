/**
 * /home などのカード列から「このリスト順でフィード再生する」ための受け渡し用ヘルパー。
 * sessionStorage 経由でアイテム列を保存し、`/?playlist=<key>` で /(フィード)へ遷移する。
 */
import type { MovieCard } from "@/lib/api/feed";

export type Playlist = {
  /** sessionStorage キーの一部 (一意にする) */
  key: string;
  /** UI 表示用の名称 (例: 月間ランキング、#巨乳) */
  title?: string;
  /** リスト中の何番目から再生するか (0-based) */
  startIndex: number;
  /** リストに含まれる作品 (カード順) */
  items: MovieCard[];
};

const STORAGE_PREFIX = "feed_playlist:";

export function savePlaylist(pl: Playlist): void {
  try {
    sessionStorage.setItem(
      STORAGE_PREFIX + pl.key,
      JSON.stringify({
        title: pl.title ?? "",
        startIndex: pl.startIndex,
        items: pl.items,
      }),
    );
  } catch {
    /* sessionStorage 容量超過などは無視 */
  }
}

export function loadPlaylist(key: string): {
  title: string;
  startIndex: number;
  items: MovieCard[];
} | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items)) return null;
    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      startIndex: Number.isFinite(parsed.startIndex) ? parsed.startIndex : 0,
      items: parsed.items as MovieCard[],
    };
  } catch {
    return null;
  }
}

export function clearPlaylist(key: string): void {
  try {
    sessionStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    /* ignore */
  }
}
