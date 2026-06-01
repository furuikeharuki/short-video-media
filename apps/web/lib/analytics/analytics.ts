/**
 * 統合計測クライアント。
 *
 * すべてのフロントイベントはここを通る。
 *
 *   trackEvent("affiliate_click", { slug, affiliate_url })
 *
 * 内部的に下記の 2 系統に振り分ける:
 *   - GA4: `window.gtag('event', ...)` のクライアント側ビーコン (ga4-client.ts)。
 *     gtag が `_ga` / `_ga_*` Cookie 由来の本物の client_id / session_id を自動付与
 *     するため、イベントが正しいユーザ・セッションに紐づく。
 *   - FastAPI /api/v1/events: ランキング集計・検索クエリ統計用
 *
 * 各イベントは「DB に積むべきか」「GA4 に送るべきか」を ROUTE_RULES で決める。
 * affiliate_click のような収益核イベントは必ず両方に送る。
 *
 * 注意: 以前は GA4 への送信を `/api/events` Route Handler → Measurement Protocol
 * (mp/collect) で行い `client_id: "anonymous"` 固定だったため、全イベントが
 * 1 ユーザ (activeUsers=1) に collapse し、ブラウザの gtag セッションとも切り離された
 * 「イベントのみのセッション」を生んでいた (landingPage 空・engagedSessions 0)。
 * その transport は廃止し、クライアント gtag に一本化した。
 */

import { sendGa4Event } from "./ga4-client";

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
  | "movie_feed_cta_click"
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

  // 作品詳細 → ショート動画フィード (/feed?v=<slug>) への送客 CTA。
  // GA4 のみ (バックエンド集計の語彙には無いため backend マッピングなし)。
  movie_feed_cta_click: { ga4: true },

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

function sendToGA4(
  event: AnalyticsEventName,
  props: AnalyticsProperties,
): void {
  // クライアント側 gtag 経由で送る。gtag が本物の client_id / session_id を
  // 付与するため、サーバー側 Measurement Protocol のような ID 固定問題が起きない。
  // SSR / gtag 未ロード環境では ga4-client 内で no-op。
  sendGa4Event(event, props);
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

  // GA4 はクライアント gtag に同期的に積む (fetch を伴わない)。
  if (rule.ga4 !== false) sendToGA4(event, properties);

  // バックエンド集計は従来どおり /api/v1/events に投げる。
  if (rule.backend) await sendToBackend(rule.backend, properties);
}
