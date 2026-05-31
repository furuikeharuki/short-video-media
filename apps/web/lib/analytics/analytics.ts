/**
 * 統合計測クライアント。
 *
 * すべてのフロントイベントはここを通る。
 *
 *   trackEvent("affiliate_click", { slug, affiliate_url })
 *
 * 内部的に下記の 2 系統に振り分ける:
 *   - GA4: ブラウザビーコン用 (/api/events Route Handler → Measurement Protocol)
 *   - FastAPI /api/v1/events: ランキング集計・検索クエリ統計用
 *
 * 各イベントは「DB に積むべきか」「GA4 に送るべきか」を ROUTE_RULES で決める。
 * affiliate_click のような収益核イベントは必ず両方に送る。
 */

const API_BASE_URL =
  // クライアント (window 経由) では NEXT_PUBLIC_API_BASE_URL のみ参照可能。
  // process.env.API_BASE_URL は SSR / build 時のみ有効。
  (typeof window === "undefined"
    ? process.env.API_BASE_URL || process.env.INTERNAL_API_BASE_URL
    : undefined) ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "";

// FastAPI 側 /api/v1/events が受け取る event_type の語彙。
// schemas/event.py の EventCreate / repositories/event_repository.py の
// ALLOWED_EVENT_TYPES と一致させること。
export type BackendEventType =
  | "view"
  | "play"
  | "detail_click"
  | "affiliate_click"
  | "search";

// 旧 trackEvent 互換のフロント語彙 (GA4 イベント名にも使う)。
export type AnalyticsEventName =
  | "page_view"
  | "age_gate_view"
  | "age_gate_pass"
  | "age_gate_exit"
  | "detail_view"
  | "affiliate_click"
  | "video_play"
  | "video_complete"
  | "scroll_depth"
  | "search"
  // 新規: バックエンドと共通の語彙
  | "view"
  | "play"
  | "detail_click";

type Routing = {
  /** GA4 に送るか (デフォルト true) */
  ga4?: boolean;
  /** FastAPI に送る場合は backend event_type へのマッピングを指定 */
  backend?: BackendEventType;
};

// フロント語彙 → ルーティング設定
const ROUTE_RULES: Record<AnalyticsEventName, Routing> = {
  // ページビュー系: GA4 のみ
  page_view: { ga4: true },
  age_gate_view: { ga4: true },
  age_gate_pass: { ga4: true },
  age_gate_exit: { ga4: true },
  scroll_depth: { ga4: true },

  // 動画再生系
  video_play: { ga4: true, backend: "play" },
  video_complete: { ga4: true },

  // 詳細閲覧
  detail_view: { ga4: true, backend: "detail_click" },
  detail_click: { ga4: true, backend: "detail_click" },

  // 収益核: 両方に必ず送る
  affiliate_click: { ga4: true, backend: "affiliate_click" },

  // 検索: 両方
  search: { ga4: true, backend: "search" },

  // バックエンド共通語彙
  view: { ga4: true, backend: "view" },
  play: { ga4: true, backend: "play" },
};

export type AnalyticsProperties = Record<string, unknown> & {
  slug?: string;
  title?: string;
  affiliate_url?: string;
  next_path?: string;
  next_kind?: string;
  search_query?: string;
};

async function sendToBackend(
  eventType: BackendEventType,
  props: AnalyticsProperties,
): Promise<void> {
  if (!API_BASE_URL) return;
  try {
    await fetch(`${API_BASE_URL}/api/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: eventType,
        slug: props.slug,
        title: props.title,
        affiliate_url: props.affiliate_url,
        next_path: props.next_path,
        search_query: props.search_query,
      }),
      keepalive: true,
    });
  } catch {
    /* ignore */
  }
}

async function sendToGA4Route(
  event: AnalyticsEventName,
  props: AnalyticsProperties,
): Promise<void> {
  try {
    await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, properties: props }),
      keepalive: true,
    });
  } catch {
    /* ignore */
  }
}

/**
 * 統合エントリーポイント。
 * フロントから呼ぶときは原則これを使う。
 */
export async function trackEvent(
  event: AnalyticsEventName,
  properties: AnalyticsProperties = {},
): Promise<void> {
  const rule = ROUTE_RULES[event];
  if (!rule) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[analytics] unknown event: ${event}`);
    }
    return;
  }

  const tasks: Promise<unknown>[] = [];
  if (rule.ga4 !== false) tasks.push(sendToGA4Route(event, properties));
  if (rule.backend) tasks.push(sendToBackend(rule.backend, properties));
  await Promise.allSettled(tasks);
}
