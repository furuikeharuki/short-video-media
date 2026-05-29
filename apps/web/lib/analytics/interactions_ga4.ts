/**
 * `interactions.ts` から発火する詳細インタラクションイベントを GA4 にも転送する
 * ためのヘルパ。
 *
 * 設計指針:
 *  - GA4 への送信は `window.gtag('event', ...)` を使ったクライアント側ビーコンに
 *    一本化する (`/api/events` を通さず Measurement Protocol を増やさない)。
 *    これにより GA4 Realtime / DebugView にすぐ反映される。
 *  - SSR / テスト環境 (`window` も `gtag` も無い) では完全に no-op。
 *  - 送るイベントは「バックエンドにも積んでいるイベント」のサブセットに限定し、
 *    余計なリスナを増やさない (`interactions.ts` の dedupe/throttle がそのまま効く)。
 *  - パラメータは GA4 制約 (キーは英数字+_, 40 文字以内, 値はおおむね 100 文字以内)
 *    に収まるホワイトリスト方式。metadata の自由形式 JSON は転送しない。
 *  - PII になりうるフィールドは元から interactions.ts に存在しないが、
 *    将来 metadata に PII を入れても GA4 には漏れないようにここでフィルタする。
 */
import type { InteractionEventName, InteractionEventPayload } from "./interactions";

// 内部語彙 → GA4 イベント名。マッピングが無いものは GA4 に送らない。
// GA4 のレポート/DebugView での見通しを良くするため、すべて `video_` プレフィックス
// に揃える (`video_complete` は元から GA4 互換)。
const EVENT_NAME_MAP: Partial<Record<InteractionEventName, string>> = {
  impression: "video_impression",
  play_progress: "video_play_progress",
  video_complete: "video_complete",
  dwell: "video_dwell",
  skip: "video_skip",
  mute: "video_mute",
  unmute: "video_unmute",
  replay: "video_replay",
  pause: "video_pause",
  resume: "video_resume",
};

// GA4 に渡す安全な params のホワイトリスト。
// metadata は丸ごと転送しない (JSON ブロブを GA4 に押し込むのは禁止)。
const GA4_PARAM_WHITELIST = [
  "slug",
  "feed_session_id",
  "feed_position",
  "session_seq",
  "surface",
  "rec_source",
  "progress_milestone",
  "progress_ratio",
  "current_time_sec",
  "duration_sec",
  "elapsed_ms",
  "direction",
] as const;

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
 * `process.env.NEXT_PUBLIC_GA4_INTERACTION_EVENTS` で明示的に "0" / "false" が
 * 指定されたときだけ無効化する。デフォルトは ON。
 * (GA Measurement ID が無い環境では gtag 自体が居ないので自動的に no-op。)
 */
function isEnabled(): boolean {
  const v = process.env.NEXT_PUBLIC_GA4_INTERACTION_EVENTS;
  if (v === "0" || v === "false") return false;
  return true;
}

/**
 * GA4 のキー命名規則 (英数字 + アンダースコア, 先頭は文字, 40 文字以内) と
 * 値の長さ制限 (100 文字) を満たすように軽くサニタイズする。
 *
 * 数値・真偽値はそのまま。文字列は 100 文字で切る。
 * オブジェクト / 配列はスキップ (GA4 はスカラー値しか受け取れない)。
 */
function sanitizeParams(
  source: InteractionEventPayload,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of GA4_PARAM_WHITELIST) {
    const value = (source as Record<string, unknown>)[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      out[key] = value.length > 100 ? value.slice(0, 100) : value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      // progress_ratio のような少数は GA4 ダッシュボードで読みやすいように
      // 小数 4 桁で丸める。整数はそのまま。
      out[key] = Number.isInteger(value) ? value : Number(value.toFixed(4));
    } else if (typeof value === "boolean") {
      out[key] = value;
    }
    // それ以外 (object / function 等) は捨てる。
  }
  // item_id は GA4 標準パラメータ。slug をエイリアスとして同送し、
  // 既存レポートで item_id を使うウィジェットでも拾えるようにする。
  if (typeof out.slug === "string") {
    out.item_id = out.slug;
  }
  return out;
}

/**
 * `trackInteraction` の内部から呼ばれる。GA4 にイベントを 1 件送る。
 * 失敗 / 環境不在は静かに no-op。
 *
 * テスト用にエクスポートする `mapInteractionEventToGa4Name` と
 * `buildGa4Params` も参照すること。
 */
export function forwardInteractionToGa4(payload: InteractionEventPayload): void {
  if (!isEnabled()) return;
  const gtag = getGtag();
  if (!gtag) return;
  const ga4Name = EVENT_NAME_MAP[payload.event_name];
  if (!ga4Name) return; // GA4 に出さないイベント
  try {
    gtag("event", ga4Name, sanitizeParams(payload));
  } catch {
    /* ignore */
  }
}

// ---- 以下はテスト用 export (本番コードからは直接呼ばない) ----

export function mapInteractionEventToGa4Name(
  name: InteractionEventName,
): string | undefined {
  return EVENT_NAME_MAP[name];
}

export function buildGa4Params(
  payload: InteractionEventPayload,
): Record<string, unknown> {
  return sanitizeParams(payload);
}
