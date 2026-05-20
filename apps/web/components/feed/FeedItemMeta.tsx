"use client";

import type { MovieCard } from "@/lib/api/feed";
import { logEvent } from "@/lib/api/events";

interface Props {
  item: MovieCard;
}

export default function FeedItemMeta({ item }: Props) {
  const handleTagClick = (tag: string) => {
    // タグタップも「検索」として集計 (検索数ランキングに反映させる)
    logEvent({ event_type: "search", search_query: tag });
    // /feed (ショート動画画面) からの遷移はフルページ遷移にして確実に動かす。
    // BottomNav と同じ理由: pushState/replaceState・@modal 並列ルート・<video> 等の
    // 副作用が SPA 遷移を不安定にするため。
    const href = `/search?genre=${encodeURIComponent(tag)}`;
    window.location.assign(href);
  };

  return (
    <div className="info-overlay" onClick={(e) => e.stopPropagation()}>
      {item.genres && item.genres.length > 0 && (
        <div className="genre-chips" onClick={(e) => e.stopPropagation()}>
          {item.genres.map((tag) => (
            <button
              key={tag}
              className="genre-chip"
              onClick={() => handleTagClick(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      <h2 className="item-title">{item.title}</h2>
      {item.actresses.length > 0 && (
        <p className="item-actress">👤 {item.actresses.join(" / ")}</p>
      )}
    </div>
  );
}
