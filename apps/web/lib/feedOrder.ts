import type { MovieCard } from "@/lib/api/feed";

const SEEN_KEY = "seen_movie_ids";
const MAX_SEEN = 500; // 保持上限（古いものから自動削除）

export function getSeenIds(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function markSeen(id: string): void {
  try {
    const ids = [...getSeenIds(), id];
    // 上限超過時は年山層削除
    const trimmed = ids.length > MAX_SEEN ? ids.slice(ids.length - MAX_SEEN) : ids;
    localStorage.setItem(SEEN_KEY, JSON.stringify(trimmed));
  } catch {
    // localStorage 不可な璯境では無視
  }
}

/** Fisher-Yates シャッフル */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 未視聴をランダム順で先に、視聴済みをランダム順で後に並べる
 */
export function sortBySeenStatus(items: MovieCard[]): MovieCard[] {
  const seen = getSeenIds();
  const unseen = shuffle(items.filter((i) => !seen.has(i.id)));
  const seenItems = shuffle(items.filter((i) => seen.has(i.id)));
  return [...unseen, ...seenItems];
}
