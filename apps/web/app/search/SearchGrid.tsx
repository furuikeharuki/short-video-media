"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { MovieCard } from "@/lib/api/feed";

const STORAGE_KEY     = "search_feed_items";
const STORAGE_KEY_IDX = "search_feed_index";
const STORAGE_KEY_Q   = "search_feed_query";

interface Props {
  items: MovieCard[];
  /** 検索条件を表す一意なキー（genre 名 or テキストクエリ） */
  queryKey: string;
}

export default function SearchGrid({ items, queryKey }: Props) {
  const router = useRouter();

  // マウント時：検索条件が変わっていたら保存済みインデックスをリセット
  useEffect(() => {
    try {
      const prevQuery = sessionStorage.getItem(STORAGE_KEY_Q);
      if (prevQuery !== queryKey) {
        // 検索条件が変わったので順番・位置をリセット
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(items));
        sessionStorage.setItem(STORAGE_KEY_Q, queryKey);
        sessionStorage.removeItem(STORAGE_KEY_IDX);
      }
      // 同じ条件ならすでに保存済みの items/index をそのまま活かす（上書きしない）
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClick = (item: MovieCard) => {
    try {
      // グリッドからタップした場合は選択した id を渡し、インデックスをリセット
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(items));
      sessionStorage.setItem(STORAGE_KEY_Q, queryKey);
      sessionStorage.removeItem(STORAGE_KEY_IDX); // SearchFeedPage 側で id から解決させる
    } catch { /* ignore */ }
    router.push(`/search/feed?id=${encodeURIComponent(item.id)}`);
  };

  return (
    <div className="search-grid">
      {items.map((item, index) => (
        <div
          key={item.id}
          onClick={() => handleClick(item)}
          style={cardStyle}
        >
          <div style={thumbWrapStyle}>
            <img
              src={item.image_url_list ?? item.image_url_large ?? ""}
              alt={item.title}
              style={thumbStyle}
              loading={index < 6 ? "eager" : "lazy"}
              width={360}
              height={640}
            />
            {item.sample_movie_url && (
              <span style={playBadgeStyle}>▶</span>
            )}
          </div>
          <p style={cardTitleStyle}>{item.title}</p>
        </div>
      ))}
    </div>
  );
}

export { STORAGE_KEY, STORAGE_KEY_IDX, STORAGE_KEY_Q };

const cardStyle: React.CSSProperties = {
  display: "block",
  cursor: "pointer",
  color: "#fff",
  position: "relative",
  WebkitTapHighlightColor: "transparent",
};
const thumbWrapStyle: React.CSSProperties = {
  position: "relative",
  width: "100%",
  paddingBottom: "177.77%",
  background: "#111",
  overflow: "hidden",
};
const thumbStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
  transition: "transform 0.2s ease",
};
const playBadgeStyle: React.CSSProperties = {
  position: "absolute",
  bottom: "6px",
  left: "6px",
  fontSize: "12px",
  color: "rgba(255,255,255,0.8)",
  textShadow: "0 1px 4px rgba(0,0,0,0.8)",
};
const cardTitleStyle: React.CSSProperties = {
  fontSize: "11px",
  lineHeight: 1.3,
  padding: "4px 4px 8px",
  color: "rgba(255,255,255,0.75)",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};
