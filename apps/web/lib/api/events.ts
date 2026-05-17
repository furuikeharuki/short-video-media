/**
 * バックエンド向け計測イベントクライアント (互換ラッパー)。
 *
 * 新規実装では `lib/analytics/analytics.ts` の `trackEvent` を直接呼ぶこと。
 * このファイルは既存コード (FeedClient / Header / FeedItemMeta / MovieCardThumb 等)
 * からの呼び出し互換のために残している。
 */

import { trackEvent, type BackendEventType } from "@/lib/analytics/analytics";

export type EventType = BackendEventType;

export type EventPayload = {
  event_type: EventType;
  slug?: string;
  title?: string;
  affiliate_url?: string;
  next_path?: string;
  search_query?: string;
};

export async function logEvent(payload: EventPayload): Promise<void> {
  const { event_type, ...rest } = payload;
  await trackEvent(event_type, rest);
}
