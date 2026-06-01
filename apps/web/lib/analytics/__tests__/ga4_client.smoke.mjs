// Node の built-in test runner で ga4-client の純粋ロジック (params サニタイズ) と
// gtag 経由送信の挙動を検証する軽量スモークテスト。web には正式な test runner が
// 無いため、リポジトリ root から
//
//   node --test apps/web/lib/analytics/__tests__/ga4_client.smoke.mjs
//
// で単独実行する。検証対象のロジックを esbuild-free で評価したいので、実装の
// サニタイズ仕様をここに小さく複製する。仕様が変わった場合はここも追従させること。
import { test } from "node:test";
import assert from "node:assert/strict";

// ---- 実装 (lib/analytics/ga4-client.ts) の sanitizeGa4Params の複製 ----
function sanitizeGa4Params(props) {
  const out = {};
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      out[key] = value.length > 100 ? value.slice(0, 100) : value;
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

// ---- gtag 経由送信の最小実装 (window/gtag の有無で no-op になることを検証) ----
function sendGa4Event(getGtag, event, props) {
  const gtag = getGtag();
  if (!gtag) return false;
  try {
    gtag("event", event, sanitizeGa4Params(props));
    return true;
  } catch {
    return false;
  }
}

test("string / number / boolean scalars survive sanitize", () => {
  const out = sanitizeGa4Params({
    slug: "abc123",
    next_kind: "feed",
    feed_position: 3,
    progress_ratio: 0.5,
    muted: true,
  });
  assert.equal(out.slug, "abc123");
  assert.equal(out.next_kind, "feed");
  assert.equal(out.feed_position, 3);
  assert.equal(out.progress_ratio, 0.5);
  assert.equal(out.muted, true);
});

test("null / undefined values are dropped", () => {
  const out = sanitizeGa4Params({
    slug: "abc",
    title: null,
    next_path: undefined,
  });
  assert.equal(out.slug, "abc");
  assert.ok(!("title" in out));
  assert.ok(!("next_path" in out));
});

test("non-scalar values (object / array / function) are dropped", () => {
  const out = sanitizeGa4Params({
    slug: "abc",
    metadata: { a: 1 },
    list: [1, 2, 3],
    fn: () => {},
  });
  assert.equal(out.slug, "abc");
  assert.ok(!("metadata" in out));
  assert.ok(!("list" in out));
  assert.ok(!("fn" in out));
});

test("non-finite numbers (NaN / Infinity) are dropped", () => {
  const out = sanitizeGa4Params({
    a: Number.NaN,
    b: Number.POSITIVE_INFINITY,
    c: 42,
  });
  assert.ok(!("a" in out));
  assert.ok(!("b" in out));
  assert.equal(out.c, 42);
});

test("string values longer than 100 chars are truncated", () => {
  const out = sanitizeGa4Params({ title: "x".repeat(250) });
  assert.equal(out.title.length, 100);
});

test("no gtag (SSR / not loaded) => no-op, never throws", () => {
  // window/gtag が居ない環境を模す: getGtag が null を返す。
  const sent = sendGa4Event(() => null, "age_gate_view", { next_kind: "feed" });
  assert.equal(sent, false);
});

test("gtag present => forwards event name + sanitized params", () => {
  const calls = [];
  const fakeGtag = (command, name, params) => {
    calls.push({ command, name, params });
  };
  const sent = sendGa4Event(() => fakeGtag, "age_gate_pass", {
    next_path: "/feed",
    next_kind: "feed",
    bad: { nested: true },
  });
  assert.equal(sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "event");
  assert.equal(calls[0].name, "age_gate_pass");
  assert.equal(calls[0].params.next_path, "/feed");
  assert.equal(calls[0].params.next_kind, "feed");
  assert.ok(!("bad" in calls[0].params));
});
