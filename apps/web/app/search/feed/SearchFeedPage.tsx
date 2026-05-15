"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import FeedViewer from "@/components/FeedViewer";
import type { MovieCard } from "@/lib/api/feed";

const STORAGE_KEY = "search_feed_items";

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

  return <FeedViewer items={items} initialIndex={0} />;
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
