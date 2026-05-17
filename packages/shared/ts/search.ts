/**
 * Search 関連型 (web 側で利用)。
 *
 * Source of Truth: apps/api/app/schemas/search.py
 * jsonschema: ./jsonschema/search.schema.json
 */

import type { MovieCard } from "./movie";

export type SearchResult = {
  query: string;
  items: MovieCard[];
  next_cursor: string | null;
  has_next: boolean;
  total: number | null;
  filters_applied: Record<string, unknown>;
};
