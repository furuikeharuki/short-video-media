// /feed と / / /mypage の間で BottomNav が window.location.assign による
// フルページ遷移を起こす際、新しいページの "first paint" のタイミングで
// Chrome がボトムナビの compositing レイヤを作り直すと、active state やシークバー
// 周りの視覚要素が 1-2 フレームだけ目に見える形でずれて見える (= "Chrome 限定の
// チラつき")。
//
// これを完全に抑えるため、遷移開始の瞬間に「離脱直前のナビの視覚状態」を
// sessionStorage に書き出し (= スナップショット)、新ページの first paint より
// 前にレイアウトレベル (html data attribute) で同じ状態を適用してから、
// 2-3 フレーム後に解除して本来の状態へ滑らかに移行する。
//
// 主役は CSS。BottomNav 自体の React state は変えない (= ハイドレーション
// ミスマッチを起こさない)。
//
// - SS キー: bottom_nav_freeze
// - 値:     { activeHref: string, ts: number }
// - TTL:    NAV_FREEZE_TTL_MS (これ以上経っていたら使わない。安全弁)

export const BOTTOM_NAV_FREEZE_KEY = "bottom_nav_freeze";
export const BOTTOM_NAV_FREEZE_TTL_MS = 5000;

export type BottomNavFreezeSnapshot = {
  activeHref: string;
  ts: number;
};

export function writeBottomNavFreezeSnapshot(activeHref: string): void {
  if (typeof window === "undefined") return;
  try {
    const payload: BottomNavFreezeSnapshot = { activeHref, ts: Date.now() };
    sessionStorage.setItem(BOTTOM_NAV_FREEZE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore: プライベートモード等で書けないだけなら freeze なしで進む */
  }
}

export function readBottomNavFreezeSnapshot(): BottomNavFreezeSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(BOTTOM_NAV_FREEZE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BottomNavFreezeSnapshot | null;
    if (!parsed || typeof parsed.activeHref !== "string" || typeof parsed.ts !== "number") {
      return null;
    }
    if (Date.now() - parsed.ts > BOTTOM_NAV_FREEZE_TTL_MS) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearBottomNavFreezeSnapshot(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(BOTTOM_NAV_FREEZE_KEY);
  } catch {
    /* ignore */
  }
}
