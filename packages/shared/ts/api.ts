/**
 * API エンドポイント定数とイベント種別。
 *
 * apps/web から `@short-video-media/shared/api` で import するか、
 * 単純に `apps/web/lib/api/*.ts` の型を参照する。
 */

export const API_V1_BASE = "/api/v1";

export const ENDPOINTS = {
  health: `${API_V1_BASE}/health`,
  feed: `${API_V1_BASE}/feed`,
  movie: (slug: string) => `${API_V1_BASE}/movies/${encodeURIComponent(slug)}`,
  movieSampleUrl: (slug: string) =>
    `${API_V1_BASE}/movies/${encodeURIComponent(slug)}/sample-url`,
  search: `${API_V1_BASE}/search`,
  tags: `${API_V1_BASE}/tags`,
  events: `${API_V1_BASE}/events`,
  rankings: `${API_V1_BASE}/rankings`,
  home: `${API_V1_BASE}/home`,
  authSignIn: `${API_V1_BASE}/auth/sign-in`,
  authExchange: `${API_V1_BASE}/auth/exchange`,
  me: `${API_V1_BASE}/me`,
  actress: (name: string) =>
    `${API_V1_BASE}/actresses/${encodeURIComponent(name)}`,
} as const;

/** apps/api/app/repositories/event_repository.py の ALLOWED_EVENT_TYPES と一致させること */
export const EVENT_TYPES = [
  "view",
  "play",
  "affiliate_click",
  "search",
  "share",
  "favorite_add",
  "favorite_remove",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
