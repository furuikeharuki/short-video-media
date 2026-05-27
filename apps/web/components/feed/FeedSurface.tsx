"use client";

/**
 * FeedViewer (高速スワイプ・動画プリフェッチ等) を、視聴履歴記録などの共通ハーネス
 * 付きで描画するラッパー。
 *
 * 「再生順や継足しは入口ごとに別ロジックだが、再生アルゴリズム本体と view 計測は
 * どこから入っても同じ振る舞いにしたい」という要件を満たすために、FeedClient と
 * SearchFeedPage の両方からこのコンポーネントを使う。
 *
 * このコンポーネントは items の中身を一切並べ替えない。呼び出し側が決めた
 * `items` / `initialIndex` をそのまま FeedViewer に渡すだけ — つまり
 *   - /feed (通常):     FeedClient が seed-based に並べた items
 *   - /feed?playlist=:  ホーム/視聴履歴/ブックマーク/検索結果/女優ページから保存された順
 *   - /feed?v=<slug>:   pin した1作品を先頭にした順
 *   - /search/feed:     SearchFeedPage が組み立てた順 (shuffle 後)
 * いずれも本コンポーネント側では並びを変えない。
 */

import { useCallback } from "react";
import FeedViewer from "@/components/FeedViewer";
import { useFeedViewTracking } from "./useFeedViewTracking";
import type { MovieCard } from "@/lib/api/feed";

interface Props {
  items: MovieCard[];
  initialIndex?: number;
  /** false の間は初回 view を抑止 (まだ取得中など)。 */
  ready?: boolean;
  /** 現在 index を保存する sessionStorage キー。null/未指定で保存しない。 */
  sessionIndexKey?: string | null;
  /** 末尾接近時に呼ばれる。継足し fetch を行う入口だけ実装すればよい。 */
  onNearEnd?: (currentIndex: number) => void;
  /** 親が追加でフックしたい index 変化通知 (任意)。 */
  onIndexChange?: (index: number) => void;
}

export default function FeedSurface({
  items,
  initialIndex = 0,
  ready = true,
  sessionIndexKey = null,
  onNearEnd,
  onIndexChange,
}: Props) {
  const { handleIndexChange: trackingHandler } = useFeedViewTracking({
    items,
    initialIndex,
    ready,
    sessionIndexKey,
  });

  const combinedIndexChange = useCallback(
    (index: number) => {
      trackingHandler(index);
      onIndexChange?.(index);
    },
    [trackingHandler, onIndexChange],
  );

  return (
    <FeedViewer
      items={items}
      initialIndex={initialIndex}
      onIndexChange={combinedIndexChange}
      onNearEnd={onNearEnd}
    />
  );
}
