/**
 * クライアントから view / play / detail_click / affiliate_click / search イベントを
 * バックエンドに記録する軽量クライアント。
 *
 * 失敗してもユーザー体験に影響を与えないよう、エラーは握りつぶす。
 */

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000";

export type EventType =
  | "view"
  | "play"
  | "detail_click"
  | "affiliate_click"
  | "search";

export type EventPayload = {
  event_type: EventType;
  slug?: string;
  title?: string;
  affiliate_url?: string;
  next_path?: string;
  search_query?: string;
};

export async function logEvent(payload: EventPayload): Promise<void> {
  try {
    // keepalive で SPA 遷移中でも送信を保証
    await fetch(`${API_BASE_URL}/api/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch {
    /* ignore */
  }
}
