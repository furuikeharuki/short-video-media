import type { MovieCard } from "@/lib/api/feed";

const SEEN_KEY = "seen_movie_ids";
const MAX_SEEN = 500;

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
    const trimmed = ids.length > MAX_SEEN ? ids.slice(ids.length - MAX_SEEN) : ids;
    localStorage.setItem(SEEN_KEY, JSON.stringify(trimmed));
  } catch {}
}

export function clearSeen(): void {
  try {
    localStorage.removeItem(SEEN_KEY);
  } catch {}
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 未視聴をランダム順で先に、視聴済みをランダム順で後に。
 * 全視聴済の場合は seen をリセットして全体をシャッフル。
 */
export function sortBySeenStatus(items: MovieCard[]): MovieCard[] {
  const seen = getSeenIds();
  const unseen = items.filter((i) => !seen.has(i.id));

  if (unseen.length === 0) {
    // 全部視聴済み → リセットしてシャッフル
    clearSeen();
    return shuffle(items);
  }

  return [...shuffle(unseen), ...shuffle(items.filter((i) => seen.has(i.id)))];
}
