const SEEN_KEY = "seen_movie_ids";
const MAX_SEEN = 2000;

// ページロードごとに新しい seed を生成する。
// sessionStorage に保存しないのでリロード・更新で必ず再ランダム化される。
export function getOrCreateSeed(): number {
  return Math.floor(Math.random() * 2147483647);
}

// 全周完了時のリセット用（同様に新しい値を返すだけ）
export function resetSeed(): number {
  return Math.floor(Math.random() * 2147483647);
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
