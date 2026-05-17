/**
 * Feed 関連型 (web 側で利用)。
 *
 * Source of Truth: apps/api/app/schemas/feed.py
 * jsonschema: ./jsonschema/feed.schema.json
 */

import type { MovieCard } from "./movie";

export type FeedPage = {
  items: MovieCard[];
  next_cursor: string | null;
  has_next: boolean;
  total: number | null;
};
