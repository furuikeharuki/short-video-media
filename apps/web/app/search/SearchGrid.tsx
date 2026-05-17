"use client";

import MovieCardThumb from "@/components/home/MovieCardThumb";
import type { MovieCard } from "@/lib/api/feed";

interface Props {
  items: MovieCard[];
  /** プレイリスト識別子の一部 (検索ワード / ジャンル名 など、一意になればOK)。 */
  playlistKey?: string;
  /** プレイリストの UI 表示用タイトル。 */
  playlistTitle?: string;
}

/**
 * 検索結果カードグリッド。
 * 視聴履歴・ブックマーク欄と同じ MovieCardThumb を使い、サムネ・2 行タイトル・女優名を表示する。
 * タップすると検索結果の順序でフィード再生が始まる (playlist 機構)。
 */
export default function SearchGrid({
  items,
  playlistKey = "search",
  playlistTitle,
}: Props) {
  return (
    <div className="search-grid">
      {items.map((item, index) => (
        <MovieCardThumb
          key={item.id}
          movie={item}
          aspect="portrait"
          fluid
          playlist={{
            key: `${playlistKey}-${item.id}`,
            title: playlistTitle,
            startIndex: index,
            items,
          }}
        />
      ))}
    </div>
  );
}
