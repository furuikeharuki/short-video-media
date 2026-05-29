"use client";

/**
 * FeedViewer を直接マウントするどの入口 (/feed, /search/feed, モーダル経由など) でも
 * 同じ「動画を表示したとき」のサイドエフェクトを共有するためのフック。
 *
 * 元々 apps/web/app/FeedClient.tsx の handleIndexChange / firstView useEffect に
 * インライン展開されていたロジックを抽出し、再利用可能にしたもの。再生順序や
 * フィルター・継足し戦略には触れない — あくまで「現在 active の動画が何か」を
 * 入力として、視聴履歴 / 既読 / ランキング集計 と DOM index の sessionStorage 保存を
 * 担う。
 *
 * 共通化の意図:
 *  - ホーム / 検索 / ブックマーク / 視聴履歴 / 女優 / playlist 経由 / /feed?v= / 直接 /feed
 *    どの入口から FeedViewer に乗っても同一のイベント送信が走るようにする。
 *  - sessionStorage の index 永続化キーは入口ごとに分けたいので `sessionIndexKey`
 *    で差し替え可能にしている (FeedClient は "feed_index"; SearchFeedPage は
 *    別キーを使う想定)。null を渡すと永続化をスキップする。
 */

import { useCallback, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import type { MovieCard } from "@/lib/api/feed";
import { markSeen } from "@/lib/feedOrder";
import { logEvent } from "@/lib/api/events";
import { recordView } from "@/lib/api/me";
import {
  getOrCreateFeedSessionId,
  nextSessionSeq,
  trackInteraction,
  trackInteractionDeduped,
} from "@/lib/analytics/interactions";

interface Options {
  items: MovieCard[];
  initialIndex: number;
  /** false の間は「初回 view」を発火させない (まだロード中など)。 */
  ready: boolean;
  /** 現在 index を保存する sessionStorage キー。null なら保存しない。 */
  sessionIndexKey?: string | null;
  /** どの入口の feed か (home / search / actress / tag / ranking 等)。レコメンド集計用。 */
  surface?: string | null;
  /** 詳細レコメンドソース ("ranking_daily" / "search:tag=xxx" / "actress:slug" 等)。 */
  recSource?: string | null;
}

interface Result {
  /** FeedViewer の onIndexChange にそのまま渡す。 */
  handleIndexChange: (index: number) => void;
}

export function useFeedViewTracking({
  items,
  initialIndex,
  ready,
  sessionIndexKey = null,
  surface = null,
  recSource = null,
}: Options): Result {
  const { status: authStatus } = useSession();

  // 直前の active slide。次の active 切替時に dwell (滞在時間) を 1 回吐くために使う。
  const lastActiveRef = useRef<{ slug: string; at: number; pos: number } | null>(
    null,
  );

  const emitImpressionAndDwell = useCallback(
    (cur: MovieCard, index: number) => {
      const sessionId = getOrCreateFeedSessionId();
      const seq = nextSessionSeq();
      // (session, slug, position) で dedupe。スクロール戻りで二重 impression を防ぐ。
      trackInteractionDeduped(`imp:${sessionId}:${cur.slug}:${index}`, {
        event_name: "impression",
        slug: cur.slug,
        feed_session_id: sessionId,
        feed_position: index,
        session_seq: seq,
        surface: surface ?? undefined,
        rec_source: recSource ?? undefined,
      });
      // 直前 active の dwell を送る (滞在時間)。
      const prev = lastActiveRef.current;
      const now = Date.now();
      if (prev && prev.slug !== cur.slug) {
        trackInteraction({
          event_name: "dwell",
          slug: prev.slug,
          feed_session_id: sessionId,
          feed_position: prev.pos,
          session_seq: nextSessionSeq(),
          surface: surface ?? undefined,
          rec_source: recSource ?? undefined,
          elapsed_ms: Math.max(0, now - prev.at),
        });
      }
      lastActiveRef.current = { slug: cur.slug, at: now, pos: index };
    },
    [surface, recSource],
  );

  const handleIndexChange = useCallback(
    (index: number) => {
      const cur = items[index];
      if (cur) {
        markSeen(cur.id);
        logEvent({ event_type: "view", slug: cur.slug, title: cur.title });
        if (authStatus === "authenticated") {
          void recordView(cur.id);
        }
        emitImpressionAndDwell(cur, index);
      }
      if (sessionIndexKey) {
        try {
          sessionStorage.setItem(sessionIndexKey, String(index));
        } catch {
          /* ignore */
        }
      }
    },
    [items, authStatus, sessionIndexKey, emitImpressionAndDwell],
  );

  // 初回表示の view 記録 (FeedViewer は最初の slide については onIndexChange を呼ばない)。
  const firstViewLoggedRef = useRef(false);
  useEffect(() => {
    if (!ready) return;
    if (firstViewLoggedRef.current) return;
    const cur = items[initialIndex];
    if (!cur) return;
    firstViewLoggedRef.current = true;
    markSeen(cur.id);
    logEvent({ event_type: "view", slug: cur.slug, title: cur.title });
    if (authStatus === "authenticated") {
      void recordView(cur.id);
    }
    emitImpressionAndDwell(cur, initialIndex);
  }, [ready, items, initialIndex, authStatus, emitImpressionAndDwell]);

  // タブクローズ / 非表示時に最後の dwell を吐く。sendBeacon で送るので
  // bfcache 直前でも届く。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const flush = () => {
      const prev = lastActiveRef.current;
      if (!prev) return;
      trackInteraction({
        event_name: "dwell",
        slug: prev.slug,
        feed_session_id: getOrCreateFeedSessionId(),
        feed_position: prev.pos,
        surface: surface ?? undefined,
        rec_source: recSource ?? undefined,
        elapsed_ms: Math.max(0, Date.now() - prev.at),
        metadata: { reason: "page_hidden" },
      });
      lastActiveRef.current = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [surface, recSource]);

  return { handleIndexChange };
}
