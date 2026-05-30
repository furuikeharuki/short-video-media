"use client";

/**
 * GA4 User-ID 計測のためのバインダ。
 *
 * 設計指針:
 *  - Auth.js のセッション (`session.userId` = FastAPI が発行した内部 UUID) を
 *    `gtag('config', GA_ID, { user_id })` および `gtag('set', { user_id })` に
 *    流し込み、GA4 上で「同一ユーザーをデバイス横断で同一 ID として扱う」状態を作る。
 *    これで「DAU のうちログイン済みは何%か」「ログイン後の滞在/コンバージョン」が
 *    GA4 単体で測れるようになる。
 *  - GA4 が受け取れる user_id は文字列 256 文字以内・英数字/ハイフン推奨。
 *    内部 UUID (36 文字) はそのまま安全に渡せる。
 *  - PII 防止: ここで渡すのは provider に紐づかない内部 UUID のみ。
 *    Twitter / Discord 由来の name / email / picture は session/JWT 双方から
 *    既に剥がされている (auth.ts callbacks 参照)。
 *  - SSR / `gtag` 未ロード環境 / GA_ID 未設定では完全に no-op。
 *  - ログイン直後 (== `userId` が「無 → 有」に変化したフレーム) で
 *    `gtag('event', 'login', { method: provider })` を 1 回だけ送る。
 *    これにより GA4 のレポートで「ログイン回数」「プロバイダ別ログイン率」が見える。
 *  - ログアウト (== `userId` が「有 → 無」) では `user_id` を解除する。
 *    GA4 は `user_id: undefined` を渡すと以降の hit から user-id を外す挙動。
 */

import { useSession } from "next-auth/react";
import { useEffect, useRef } from "react";

type GtagFn = (
  command: "event" | "set" | "config",
  targetOrEventOrParams: string | Record<string, unknown>,
  params?: Record<string, unknown>,
) => void;

function getGtag(): GtagFn | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { gtag?: GtagFn };
  return typeof w.gtag === "function" ? w.gtag : null;
}

/**
 * `userId` の前回値を保持し、変化したときだけ gtag を叩く。
 * SessionProvider の下、Header 兄弟として layout.tsx に 1 個だけ置く想定。
 */
export default function Ga4UserIdBinder() {
  const { data: session, status } = useSession();
  const lastUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    // セッション解決中は何もしない。auth.ts は exchange 失敗時 session=null を返すため、
    // status === "authenticated" でかつ userId が文字列のときだけ「本物のログイン」とみなす。
    if (status === "loading") return;

    const gtag = getGtag();
    if (!gtag) return;

    const GA_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
    if (!GA_ID) return;

    const currentUserId =
      status === "authenticated" && session && typeof session.userId === "string"
        ? session.userId
        : null;

    const prevUserId = lastUserIdRef.current;
    if (currentUserId === prevUserId) return; // 変化なし

    try {
      if (currentUserId) {
        // ログイン状態を GA4 に伝える。`config` の再呼び出しは Google 推奨の
        // 「user_id を後から設定する」手順 (https://developers.google.com/analytics/devguides/collection/ga4/user-id)。
        // `set` も併用するのは、`config` 後に発火する単発 event でも user_id が
        // 確実に紐づくようにするため。
        gtag("config", GA_ID, { user_id: currentUserId });
        gtag("set", { user_id: currentUserId });

        // 「無 → 有」のときだけ login イベントを 1 回。
        // セッション復元 (リロードで currentUserId === prevUserId === null から
        // currentUserId !== null になる初回) でも 1 件は発火するが、それは
        // 「このブラウザでログイン継続中である」シグナルとして GA4 上で有用なので
        // 容認する (重複抑制は後段の GA4 標準 dedupe に任せる)。
        if (!prevUserId) {
          const provider =
            session && typeof session.provider === "string"
              ? session.provider
              : "unknown";
          gtag("event", "login", { method: provider });
        }
      } else if (prevUserId) {
        // ログアウト or セッション失効。以降の hit から user_id を外す。
        gtag("set", { user_id: undefined });
        gtag("event", "logout", {});
      }
    } catch {
      /* gtag 周りで例外が出てもアプリ側の挙動には影響させない */
    }

    lastUserIdRef.current = currentUserId;
  }, [session, status]);

  return null;
}
