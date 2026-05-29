"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import FeedSurface from "@/components/feed/FeedSurface";
import type { MovieCard } from "@/lib/api/feed";

const STORAGE_KEY = "search_feed_items";
// /search/feed の現在 index を保存する sessionStorage キー。
// /feed (FeedClient) とはキーを分けて、入口ごとに独立した位置記憶にする。
const SEARCH_FEED_INDEX_KEY = "search_feed_index";

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function SearchFeedPage() {
  const searchParams = useSearchParams();
  const selectedId   = searchParams.get("id") ?? null;

  const initialized = useRef(false);
  const [items,   setItems]   = useState<MovieCard[]>([]);
  const [isEmpty, setIsEmpty] = useState(false);

  // 検索結果フィードの並び順アルゴリズム (selected 先頭 + 残りを shuffle) は
  // 現状の挙動を維持。FeedSurface に渡る items の順序は変更しない。
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) { setIsEmpty(true); return; }
      const arr: MovieCard[] = JSON.parse(raw);
      if (arr.length === 0) { setIsEmpty(true); return; }
      const selected = (selectedId ? arr.find((m) => m.id === selectedId) : null) ?? arr[0];
      const rest     = shuffle(arr.filter((m) => m.id !== selected.id));
      setItems([selected, ...rest]);
    } catch { setIsEmpty(true); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isEmpty) {
    return (
      <div style={emptyStyle}>該当する作品が見つかりませんでした</div>
    );
  }

  if (items.length === 0) {
    return <div style={emptyStyle}>読み込み中...</div>;
  }

  // FeedSurface 経由で FeedViewer を描画することで、/feed (FeedClient) と同じ
  // 再生アルゴリズム (高速スワイプ・動画プリフェッチ・ウィンドウィング・広告挿入)
  // と、同じ視聴ログ (markSeen / view イベント / 視聴履歴記録) が適用される。
  return (
    <FeedSurface
      items={items}
      initialIndex={0}
      ready={items.length > 0}
      sessionIndexKey={SEARCH_FEED_INDEX_KEY}
      surface="search"
    />
  );
}

const emptyStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#000",
  color: "rgba(255,255,255,0.4)",
  fontSize: "14px",
};
