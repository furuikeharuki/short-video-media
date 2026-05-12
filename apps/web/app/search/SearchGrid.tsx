"use client";

import { useRouter } from "next/navigation";
import type { MovieCard } from "@/lib/api/feed";

const STORAGE_KEY = "search_feed_items";

interface Props {
  items: MovieCard[];
}

export default function SearchGrid({ items }: Props) {
  const router = useRouter();

  const handleClick = (index: number) => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      // sessionStorage 使用不可な璯境では無視
    }
    router.push(`/search/feed?start=${index}`);
  };

  return (
    <div className="search-grid">
      {items.map((item, index) => (
        <div
          key={item.id}
          onClick={() => handleClick(index)}
          style={cardStyle}
        >
          <div style={thumbWrapStyle}>
            <img
              src={item.thumbnail_url}
              alt={item.title}
              style={thumbStyle}
              loading={index < 6 ? "eager" : "lazy"}
              width={360}
              height={640}
            />
            {item.sample_video_url && (
              <span style={playBadgeStyle}>▶</span>
            )}
          </div>
          <p style={cardTitleStyle}>{item.title}</p>
        </div>
      ))}
    </div>
  );
}

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
