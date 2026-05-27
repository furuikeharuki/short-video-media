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

interface Options {
  items: MovieCard[];
  initialIndex: number;
  /** false の間は「初回 view」を発火させない (まだロード中など)。 */
  ready: boolean;
  /** 現在 index を保存する sessionStorage キー。null なら保存しない。 */
  sessionIndexKey?: string | null;
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
}: Options): Result {
  const { status: authStatus } = useSession();

  const handleIndexChange = useCallback(
    (index: number) => {
      const cur = items[index];
      if (cur) {
        markSeen(cur.id);
        logEvent({ event_type: "view", slug: cur.slug, title: cur.title });
        if (authStatus === "authenticated") {
          void recordView(cur.id);
        }
      }
      if (sessionIndexKey) {
        try {
          sessionStorage.setItem(sessionIndexKey, String(index));
        } catch {
          /* ignore */
        }
      }
    },
    [items, authStatus, sessionIndexKey],
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
  }, [ready, items, initialIndex, authStatus]);

  return { handleIndexChange };
}
