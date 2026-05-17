/**
 * / (ホーム) のカード列から「このリスト順でフィード再生する」ための受け渡し用ヘルパー。
 * sessionStorage 経由でアイテム列を保存し、`/feed?playlist=<key>` で /feed (ショートフィード)へ遷移する。
 */
import type { MovieCard } from "@/lib/api/feed";

/**
 * プレイリストの出所。これを付けておくと /feed 側で
 * 20 件以降も同じ条件 (人気、ランキング、ジャンル絞り込み...) で継ざ足せる。
 * ジャンルは kind='section', key='genre', genre='···' の形で渡す。
 */
export type PlaylistSource = {
  kind: "section";
  /** サーバー側の section key ("popular" / "ranking_daily" / ... / "genre") */
  key: string;
  /** key='genre' のとき使用するジャンル名 */
  genre?: string;
};

export type Playlist = {
  /** sessionStorage キーの一部 (一意にする) */
  key: string;
  /** UI 表示用の名称 (例: 月間ランキング、#巨乳) */
  title?: string;
  /** リスト中の何番目から再生するか (0-based) */
  startIndex: number;
  /** リストに含まれる作品 (カード順) */
  items: MovieCard[];
  /** このプレイリストの続きを API で取りにいくための出所情報。
   * 未指定のときは /feed 側で "items だけで打ち止め" の振る舞い。 */
  source?: PlaylistSource;
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
        source: pl.source ?? null,
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
  source: PlaylistSource | null;
} | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items)) return null;
    const source =
      parsed.source && typeof parsed.source === "object" && parsed.source.kind === "section" && typeof parsed.source.key === "string"
        ? {
            kind: "section" as const,
            key: parsed.source.key,
            genre: typeof parsed.source.genre === "string" ? parsed.source.genre : undefined,
          }
        : null;
    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      startIndex: Number.isFinite(parsed.startIndex) ? parsed.startIndex : 0,
      items: parsed.items as MovieCard[],
      source,
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
