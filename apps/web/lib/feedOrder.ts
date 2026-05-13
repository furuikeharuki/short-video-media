import type { MovieCard } from "@/lib/api/feed";

const SEEN_KEY = "seen_movie_ids";
const SEED_KEY = "feed_session_seed";
const MAX_SEEN = 2000;

// セッション内で一定の seed を保持（ページ跨ぎでランダム順が崩れないように）
export function getOrCreateSeed(): number {
  try {
    const raw = sessionStorage.getItem(SEED_KEY);
    if (raw) return parseInt(raw, 10);
    const seed = Math.floor(Math.random() * 2147483647);
    sessionStorage.setItem(SEED_KEY, String(seed));
    return seed;
  } catch {
    return Math.floor(Math.random() * 2147483647);
  }
}

export function resetSeed(): number {
  try {
    const seed = Math.floor(Math.random() * 2147483647);
    sessionStorage.setItem(SEED_KEY, String(seed));
    return seed;
  } catch {
    return Math.floor(Math.random() * 2147483647);
  }
}

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
