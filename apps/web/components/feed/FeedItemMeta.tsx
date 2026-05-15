"use client";

import { useRouter } from "next/navigation";
import type { MovieCard } from "@/lib/api/feed";

interface Props {
  item: MovieCard;
}

export default function FeedItemMeta({ item }: Props) {
  const router = useRouter();

  return (
    <div className="info-overlay" onClick={(e) => e.stopPropagation()}>
      {item.genres && item.genres.length > 0 && (
        <div className="genre-chips" onClick={(e) => e.stopPropagation()}>
          {item.genres.map((tag) => (
            <button
              key={tag}
              className="genre-chip"
              onClick={() => router.push(`/search?genre=${encodeURIComponent(tag)}`)}
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
