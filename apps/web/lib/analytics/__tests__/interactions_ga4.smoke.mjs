// Node の built-in test runner で interactions_ga4 の純粋ロジックを検証する
// 軽量スモークテスト。web には正式な test runner が無いため、リポジトリ root から
//
//   node --test apps/web/lib/analytics/__tests__/interactions_ga4.smoke.mjs
//
// で単独実行する。`tsc` 出力ではなく実装ファイルを esbuild-free で評価したいので、
// 検証対象のロジック (マッピング / サニタイズ) を mjs に小さく複製する。
// 仕様が変わった場合はここも追従させること。
import { test } from "node:test";
import assert from "node:assert/strict";

const EVENT_NAME_MAP = {
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
];

function sanitizeParams(source) {
  const out = {};
  for (const key of GA4_PARAM_WHITELIST) {
    const value = source[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      out[key] = value.length > 100 ? value.slice(0, 100) : value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = Number.isInteger(value) ? value : Number(value.toFixed(4));
    } else if (typeof value === "boolean") {
      out[key] = value;
    }
  }
  if (typeof out.slug === "string") out.item_id = out.slug;
  return out;
}

test("required GA4 events are all mapped", () => {
  const required = [
    "impression",
    "play_progress",
    "video_complete",
    "dwell",
    "skip",
    "mute",
    "unmute",
    "replay",
    "pause",
    "resume",
  ];
  for (const e of required) {
    assert.ok(EVENT_NAME_MAP[e], `missing GA4 mapping for ${e}`);
    assert.match(EVENT_NAME_MAP[e], /^[a-z][a-z0-9_]*$/);
  }
});

test("metadata is dropped, only whitelist params survive", () => {
  const params = sanitizeParams({
    event_name: "play_progress",
    slug: "abc123",
    feed_position: 3,
    progress_ratio: 0.5123456,
    metadata: { user_email: "leak@example.com", muted: true },
    nonexistent_field: "x",
  });
  assert.equal(params.slug, "abc123");
  assert.equal(params.item_id, "abc123");
  assert.equal(params.feed_position, 3);
  assert.equal(params.progress_ratio, 0.5123); // rounded to 4 dp
  assert.equal(params.metadata, undefined);
  assert.equal(params.user_email, undefined);
  assert.equal(params.nonexistent_field, undefined);
});

test("null / undefined values are dropped", () => {
  const params = sanitizeParams({
    event_name: "dwell",
    slug: "abc",
    elapsed_ms: 1200,
    feed_position: null,
    rec_source: undefined,
  });
  assert.equal(params.slug, "abc");
  assert.equal(params.elapsed_ms, 1200);
  assert.ok(!("feed_position" in params));
  assert.ok(!("rec_source" in params));
});

test("string values longer than 100 chars are truncated", () => {
  const long = "x".repeat(250);
  const params = sanitizeParams({
    event_name: "impression",
    slug: long,
    surface: "home",
  });
  assert.equal(params.slug.length, 100);
  assert.equal(params.surface, "home");
});

test("unmapped events return undefined name (skipped in forward)", () => {
  assert.equal(EVENT_NAME_MAP.play, undefined);
  assert.equal(EVENT_NAME_MAP.swipe, undefined);
  assert.equal(EVENT_NAME_MAP.page_hidden, undefined);
});
