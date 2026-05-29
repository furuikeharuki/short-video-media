/**
 * フィード/動画インタラクション計測クライアント。
 *
 * 既存 `analytics.ts` の `trackEvent` は GA4 + 集計用 `/api/v1/events` 用に
 * 設計されているため、レコメンド学習向けのリッチな event は本モジュールから
 * `/api/v1/interaction-events` に投げる。
 *
 * 設計指針:
 *  - クライアントだけが値を持ち、サーバーは passthrough で保存する。
 *  - PII を含めない (生 device-id / IP / メール等)。
 *  - 同じイベントの重複送信を抑える dedupe ヘルパを提供する。
 *  - 失敗は握りつぶす (analytics は best-effort)。
 *  - `sendBeacon` が使える環境ではそれを優先 (タブ遷移時の信頼性)。
 */

import { forwardInteractionToGa4 } from "./interactions_ga4";

const API_BASE_URL =
  (typeof window === "undefined"
    ? process.env.API_BASE_URL || process.env.INTERNAL_API_BASE_URL
    : undefined) ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "";

// バックエンド `ALLOWED_INTERACTION_EVENTS` と一致させること。
export type InteractionEventName =
  | "impression"
  | "play"
  | "play_progress"
  | "video_complete"
  | "pause"
  | "resume"
  | "replay"
  | "dwell"
  | "skip"
  | "swipe"
  | "mute"
  | "unmute"
  | "page_hidden"
  | "page_visible";

export type InteractionEventPayload = {
  event_name: InteractionEventName;
  slug?: string | null;
  feed_session_id?: string | null;
  feed_position?: number | null;
  session_seq?: number | null;
  surface?: string | null;
  rec_source?: string | null;
  progress_ratio?: number | null;
  progress_milestone?: number | null;
  current_time_sec?: number | null;
  duration_sec?: number | null;
  elapsed_ms?: number | null;
  direction?: "prev" | "next" | "left" | "right" | null;
  metadata?: Record<string, unknown> | null;
};

const FEED_SESSION_KEY = "feed_session_id";
const FEED_SESSION_SEQ_KEY = "feed_session_seq";

/**
 * フィード閲覧セッション ID。tab を開いてから閉じるまでで 1 つ。
 * sessionStorage に永続化することで、同一タブ内の入口切替 (ホーム→検索→女優) を
 * またいでも同じ ID で計測できる。
 */
export function getOrCreateFeedSessionId(): string {
  if (typeof window === "undefined") return "";
  try {
    const cached = sessionStorage.getItem(FEED_SESSION_KEY);
    if (cached) return cached;
    const fresh = `feed_${makeRandomId()}`;
    sessionStorage.setItem(FEED_SESSION_KEY, fresh);
    return fresh;
  } catch {
    // sessionStorage が拒否された (private mode 等) ときは毎回新規発行で諦める。
    return `feed_${makeRandomId()}`;
  }
}

/**
 * セッション内 seq を 1 ずつ進めて返す。サーバー側で「N 番目のイベント」を
 * 並べ替える際に使う。失敗時は 0 を返して呼び出し側に判断を委ねない。
 */
export function nextSessionSeq(): number {
  if (typeof window === "undefined") return 0;
  try {
    const prev = sessionStorage.getItem(FEED_SESSION_SEQ_KEY);
    const n = prev ? Number.parseInt(prev, 10) : 0;
    const next = Number.isFinite(n) ? n + 1 : 1;
    sessionStorage.setItem(FEED_SESSION_SEQ_KEY, String(next));
    return next;
  } catch {
    return 0;
  }
}

function makeRandomId(): string {
  // crypto.randomUUID() が無い古いブラウザ向けの fallback。
  // 衝突しない強さは不要 (集計キーとしてのみ使う)。
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    try {
      return crypto.randomUUID();
    } catch {
      /* fallthrough */
    }
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function postBody(payload: InteractionEventPayload): string {
  // null は省いておく (Pydantic 側で None になるが、転送量を減らせる)。
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v !== null && v !== undefined) clean[k] = v;
  }
  return JSON.stringify(clean);
}

export function trackInteraction(payload: InteractionEventPayload): void {
  if (typeof window === "undefined") return;

  // GA4 への転送はバックエンド送信とは独立に行う。
  // gtag が未ロード / 未設定なら no-op (interactions_ga4.ts 内で判定)。
  // バックエンド未設定 (= API_BASE_URL 空) の環境でも GA4 だけは飛ぶ。
  forwardInteractionToGa4(payload);

  if (!API_BASE_URL) return;

  const url = `${API_BASE_URL}/api/v1/interaction-events`;
  const body = postBody(payload);

  // 1) ページ遷移時にも届く sendBeacon を優先。Blob で Content-Type を明示する
  //    ことで FastAPI 側の JSON パーサと整合する。
  try {
    const nav = navigator as Navigator & {
      sendBeacon?: (url: string, data?: BodyInit) => boolean;
    };
    if (typeof nav.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      if (nav.sendBeacon(url, blob)) return;
    }
  } catch {
    /* fallthrough to fetch */
  }

  // 2) 通常 fetch (keepalive 付き)。失敗は無視。
  try {
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      /* ignore */
    });
  } catch {
    /* ignore */
  }
}

/**
 * 同じキーが直近で発火していれば送信をスキップするヘルパ。
 * impression / progress milestone のように「動画 + マイルストーン」単位で
 * 1 回だけ送るユースケース向け。
 *
 * `feed_session_id` を内部キーに含めて持つので、同一動画でも feed セッションが
 * 変われば再度送れる。プロセス常駐 (= タブが生きている間) しか持たない。
 */
const _dedupeMemory = new Set<string>();
const DEDUPE_MAX = 4096;

export function trackInteractionDeduped(
  dedupeKey: string,
  payload: InteractionEventPayload,
): boolean {
  if (_dedupeMemory.has(dedupeKey)) return false;
  if (_dedupeMemory.size >= DEDUPE_MAX) {
    // 古い順に削るのは面倒なので、丸ごとクリアしてリセットする。
    _dedupeMemory.clear();
  }
  _dedupeMemory.add(dedupeKey);
  trackInteraction(payload);
  return true;
}

export function _resetInteractionDedupeForTests(): void {
  _dedupeMemory.clear();
}
