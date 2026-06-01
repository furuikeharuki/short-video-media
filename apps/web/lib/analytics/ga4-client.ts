/**
 * `analytics.ts` の `trackEvent` から GA4 へイベントを送るためのクライアント側
 * ヘルパ。
 *
 * 設計指針 (interactions_ga4.ts と同じ思想):
 *  - GA4 への送信は **必ず `window.gtag('event', ...)` のブラウザビーコン** を使う。
 *    こうすると gtag が `_ga` / `_ga_*` Cookie 由来の本物の client_id / session_id を
 *    自動付与するため、イベントが正しいユーザ・セッションに紐づき、engagement にも
 *    寄与する。
 *  - 旧実装は `/api/events` → Measurement Protocol (mp/collect) に
 *    `client_id: "anonymous"` 固定で投げていたため、全イベントが 1 ユーザ
 *    (activeUsers=1) に collapse し、ブラウザの gtag セッションとも切り離された
 *    「イベントのみのセッション」を量産していた (landingPage 空・engagedSessions 0)。
 *    その transport を廃止し、ここに一本化する。
 *  - SSR / テスト環境 (`window` も `gtag` も無い) では完全に no-op。
 *  - GA4 制約に合わせて params は文字列/数値/真偽のスカラーのみ通し、長すぎる文字列は
 *    100 文字で切る。object / 配列 / function は捨てる (GA4 はスカラーしか受けない)。
 */

import type { AnalyticsEventName, AnalyticsProperties } from "./analytics";

type GtagFn = (
  command: "event",
  eventName: string,
  params?: Record<string, unknown>,
) => void;

function getGtag(): GtagFn | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { gtag?: GtagFn };
  return typeof w.gtag === "function" ? w.gtag : null;
}

/**
 * GA4 へ渡す params をサニタイズする。
 *  - null / undefined は捨てる。
 *  - string は 100 文字で切る。
 *  - number は有限値のみ。
 *  - boolean はそのまま。
 *  - object / array / function 等の非スカラーは捨てる (GA4 非対応)。
 */
export function sanitizeGa4Params(
  props: AnalyticsProperties,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      out[key] = value.length > 100 ? value.slice(0, 100) : value;
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    }
    // それ以外 (object / array / function) は捨てる。
  }
  return out;
}

/**
 * GA4 にイベントを 1 件送る。gtag 未ロード / SSR / テスト環境では静かに no-op。
 * 例外は握りつぶす (analytics は best-effort)。
 */
export function sendGa4Event(
  event: AnalyticsEventName,
  props: AnalyticsProperties,
): void {
  const gtag = getGtag();
  if (!gtag) return;
  try {
    gtag("event", event, sanitizeGa4Params(props));
  } catch {
    /* ignore */
  }
}
