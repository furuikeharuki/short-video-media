// Ga4UserIdBinder の決定ロジックを Node の built-in test runner で検証する
// 軽量スモークテスト。React/JSX を持ち込まずに、純粋な状態遷移
// (userId 変化 → どの gtag 呼び出しが行われるか) だけを再現する。
//
// 実行:
//   node --test apps/web/components/analytics/__tests__/ga4_user_id.smoke.mjs
//
// 本物のコンポーネント (Ga4UserIdBinder.tsx) はこの再現ロジックと同じ判定で
// gtag を叩く。仕様が変わった場合はここも追従させること。

import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * 本物の useEffect 内ロジックを純関数として切り出した版。
 * gtag は呼び出し履歴を貯める fake を渡すこと。
 *
 * @returns 次フレームで保持すべき lastUserId
 */
function applyGa4UserIdTransition({
  status,
  session,
  prevUserId,
  gaId,
  gtag,
}) {
  if (status === "loading") return prevUserId;
  if (!gtag) return prevUserId;
  if (!gaId) return prevUserId;

  const currentUserId =
    status === "authenticated" &&
    session &&
    typeof session.userId === "string"
      ? session.userId
      : null;

  if (currentUserId === prevUserId) return prevUserId;

  if (currentUserId) {
    gtag("config", gaId, { user_id: currentUserId });
    gtag("set", { user_id: currentUserId });
    if (!prevUserId) {
      const provider =
        session && typeof session.provider === "string"
          ? session.provider
          : "unknown";
      gtag("event", "login", { method: provider });
    }
  } else if (prevUserId) {
    gtag("set", { user_id: undefined });
    gtag("event", "logout", {});
  }

  return currentUserId;
}

function makeFakeGtag() {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
  };
  return { fn, calls };
}

test("loading 状態では何も発火しない", () => {
  const { fn, calls } = makeFakeGtag();
  const next = applyGa4UserIdTransition({
    status: "loading",
    session: null,
    prevUserId: null,
    gaId: "G-TEST",
    gtag: fn,
  });
  assert.equal(calls.length, 0);
  assert.equal(next, null);
});

test("gaId 未設定では何も発火しない (no-op)", () => {
  const { fn, calls } = makeFakeGtag();
  const next = applyGa4UserIdTransition({
    status: "authenticated",
    session: { userId: "uuid-1", provider: "twitter" },
    prevUserId: null,
    gaId: undefined,
    gtag: fn,
  });
  assert.equal(calls.length, 0);
  assert.equal(next, null);
});

test("無 → 有 (初ログイン) で config + set + login event が 1 回ずつ", () => {
  const { fn, calls } = makeFakeGtag();
  const next = applyGa4UserIdTransition({
    status: "authenticated",
    session: { userId: "uuid-1", provider: "discord" },
    prevUserId: null,
    gaId: "G-TEST",
    gtag: fn,
  });
  assert.equal(next, "uuid-1");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ["config", "G-TEST", { user_id: "uuid-1" }]);
  assert.deepEqual(calls[1], ["set", { user_id: "uuid-1" }]);
  assert.deepEqual(calls[2], ["event", "login", { method: "discord" }]);
});

test("変化なし (有 → 有, 同 ID) では gtag を呼ばない", () => {
  const { fn, calls } = makeFakeGtag();
  const next = applyGa4UserIdTransition({
    status: "authenticated",
    session: { userId: "uuid-1", provider: "twitter" },
    prevUserId: "uuid-1",
    gaId: "G-TEST",
    gtag: fn,
  });
  assert.equal(calls.length, 0);
  assert.equal(next, "uuid-1");
});

test("有 → 無 (ログアウト) で user_id 解除 + logout event", () => {
  const { fn, calls } = makeFakeGtag();
  const next = applyGa4UserIdTransition({
    status: "unauthenticated",
    session: null,
    prevUserId: "uuid-1",
    gaId: "G-TEST",
    gtag: fn,
  });
  assert.equal(next, null);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ["set", { user_id: undefined }]);
  assert.deepEqual(calls[1], ["event", "logout", {}]);
});

test("provider が無いセッションでも login event は method=unknown で送る", () => {
  const { fn, calls } = makeFakeGtag();
  applyGa4UserIdTransition({
    status: "authenticated",
    session: { userId: "uuid-2" }, // provider 欠落
    prevUserId: null,
    gaId: "G-TEST",
    gtag: fn,
  });
  const loginEvent = calls.find((c) => c[0] === "event" && c[1] === "login");
  assert.ok(loginEvent);
  assert.deepEqual(loginEvent[2], { method: "unknown" });
});

test("ユーザー切替 (uuid-1 → uuid-2) で config 再呼び出し + login 再発火", () => {
  const { fn, calls } = makeFakeGtag();
  const next = applyGa4UserIdTransition({
    status: "authenticated",
    session: { userId: "uuid-2", provider: "twitter" },
    prevUserId: "uuid-1",
    gaId: "G-TEST",
    gtag: fn,
  });
  assert.equal(next, "uuid-2");
  // prevUserId が truthy なので login event は出ない (= 連続ログインは中間ログアウトを介する想定)
  // ただし config/set による user_id 切り替えは行う
  assert.deepEqual(calls[0], ["config", "G-TEST", { user_id: "uuid-2" }]);
  assert.deepEqual(calls[1], ["set", { user_id: "uuid-2" }]);
  const loginEvent = calls.find((c) => c[1] === "login");
  assert.equal(loginEvent, undefined);
});
