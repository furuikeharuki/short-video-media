"use client";

/**
 * ジャンル LP (`/genres/<genre>`) を「自動遷移させずに」詳細検索条件を反映させるための
 * クライアントオーバーレイ。
 *
 * 背景 / 設計方針:
 *   - ジャンル LP は ISR (全ユーザー共通キャッシュ) の SSR ページなので、ユーザー個別の
 *     保存済み詳細検索条件 (sessionStorage / サーバ /me/search-prefs) を SSR では読めない。
 *   - PR #304 ではこれを `/search?genre=...` への router.replace で解決しようとしたが、
 *     「LP を開くと勝手に検索結果ページへ飛ぶ」「初期レンダーを条件で分岐させて React #418
 *     (hydration mismatch) を誘発する」という二重の問題があり PR #305 で撤去された。
 *
 *   - 本コンポーネントは遷移させない。代わりに:
 *       1. 初期 SSR / hydration 時は何も描画しない (return null)。サーバ側が出した
 *          通常の LP グリッドがそのまま見える = hydration mismatch を起こさない。
 *       2. mount 後にクライアントで保存済み条件を読む。条件があれば、
 *          サーバが出した LP グリッド (.genre-lp-grid 等) を CSS で隠し、代わりに
 *          「genre=<現在ジャンル> AND 詳細検索条件」で絞り込んだ結果を
 *          既存 SearchInfiniteGrid (advanced source) で同じページ内に描画する。
 *       3. 条件が無ければ何もしない = 従来どおり SEO 向け LP のまま。
 *
 *   - URL は書き換えない (= 親ジャンル LP の canonical / index 可能性を維持)。
 *     条件付き状態はクライアントのみで反映されるため検索エンジンには通常 LP として
 *     見え、薄い/重複ページの index を防げる。
 *
 * 認証状態:
 *   - ログイン中: サーバ /me/search-prefs を優先 (端末をまたいで同じ条件)。空ならセッション。
 *   - 未ログイン: sessionStorage のみ。
 */

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";

import SearchInfiniteGrid from "@/app/search/SearchInfiniteGrid";
import { getSearchPref } from "@/lib/api/me";
import type { AdvancedSearchInput, SortKey } from "@/lib/api/search";
import {
  readSavedSearchPref,
  type SavedSearchPref,
} from "@/lib/savedSearchPrefs";

const VALID_SORTS = new Set<SortKey>([
  "new",
  "popular",
  "rating",
  "views",
  "bookmarks",
]);

function cleanArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const s of v) {
    if (typeof s !== "string") continue;
    const t = s.trim();
    if (t) out.push(t);
  }
  return out;
}

function cleanString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** サーバ pref (SearchPrefPayload) を SavedSearchPref 相当へ正規化。空なら null。 */
function normalizeServerPref(p: unknown): SavedSearchPref | null {
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>;
  const cleaned: SavedSearchPref = {};
  const q = cleanString(r.q);
  if (q) cleaned.q = q;
  const genres = cleanArray(r.genres);
  if (genres.length) cleaned.genres = genres;
  const actresses = cleanArray(r.actresses);
  if (actresses.length) cleaned.actresses = actresses;
  const series_list = cleanArray(r.series_list);
  if (series_list.length) cleaned.series_list = series_list;
  const directors = cleanArray(r.directors);
  if (directors.length) cleaned.directors = directors;
  const makers = cleanArray(r.makers);
  if (makers.length) cleaned.makers = makers;
  const labels = cleanArray(r.labels);
  if (labels.length) cleaned.labels = labels;
  const ng_words = cleanArray(r.ng_words);
  if (ng_words.length) cleaned.ng_words = ng_words;
  const date_from = cleanString(r.date_from);
  if (date_from) cleaned.date_from = date_from;
  const date_to = cleanString(r.date_to);
  if (date_to) cleaned.date_to = date_to;
  const sort = cleanString(r.sort);
  if (sort && VALID_SORTS.has(sort as SortKey)) cleaned.sort = sort;

  return hasAnyCondition(cleaned) ? cleaned : null;
}

function hasAnyCondition(p: SavedSearchPref): boolean {
  return Boolean(
    p.q ||
      p.genres?.length ||
      p.actresses?.length ||
      p.series_list?.length ||
      p.directors?.length ||
      p.makers?.length ||
      p.labels?.length ||
      p.ng_words?.length ||
      p.date_from ||
      p.date_to ||
      p.sort,
  );
}

/**
 * 「現在のジャンル AND 保存済み詳細検索条件」を表す AdvancedSearchInput を組み立てる。
 * genre は genres 配列に必ず含めて AND 固定する。/search ページの掛け合わせロジックと同形。
 */
function buildAdvancedInput(
  genre: string,
  pref: SavedSearchPref,
): AdvancedSearchInput {
  const genres = Array.from(new Set([genre, ...(pref.genres ?? [])]));
  const sort =
    pref.sort && VALID_SORTS.has(pref.sort as SortKey)
      ? (pref.sort as SortKey)
      : undefined;
  return {
    q: pref.q || undefined,
    genres,
    actresses: pref.actresses?.length ? pref.actresses : undefined,
    series_list: pref.series_list?.length ? pref.series_list : undefined,
    directors: pref.directors?.length ? pref.directors : undefined,
    makers: pref.makers?.length ? pref.makers : undefined,
    labels: pref.labels?.length ? pref.labels : undefined,
    ng_words: pref.ng_words?.length ? pref.ng_words : undefined,
    date_from: pref.date_from || undefined,
    date_to: pref.date_to || undefined,
    sort,
  };
}

export default function GenreFilteredView({ genre }: { genre: string }) {
  const { status } = useSession();
  // null = まだ判定前 (= 初期 SSR / hydration と同じ「何も差し替えない」状態)。
  const [pref, setPref] = useState<SavedSearchPref | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    if (status === "loading") return;
    let cancelled = false;
    (async () => {
      let p: SavedSearchPref | null = null;
      if (status === "authenticated") {
        try {
          p = normalizeServerPref(await getSearchPref());
        } catch {
          p = null;
        }
      }
      // サーバが空 / 未ログインのときは sessionStorage を見る。
      if (!p) p = readSavedSearchPref();
      if (cancelled) return;
      setPref(p);
      setResolved(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [status, genre]);

  // 条件が無い / まだ判定前: 何も差し替えない (SSR の LP がそのまま見える)。
  if (!resolved || !pref) return null;

  const input = buildAdvancedInput(genre, pref);
  const playlistKey = `genre-filtered-${JSON.stringify({
    g: input.genres,
    q: input.q,
    a: input.actresses,
    sl: input.series_list,
    d: input.directors,
    m: input.makers,
    l: input.labels,
    df: input.date_from,
    dt: input.date_to,
    s: input.sort,
  })}`;

  return (
    <>
      {/* 条件付き表示中はサーバ出力の LP グリッドを隠す。
          SSR では常に LP を出しておき、条件があるときだけクライアントで隠すので
          hydration mismatch は起こらない。 */}
      <style>{`.genre-lp-default { display: none !important; }`}</style>
      <SearchInfiniteGrid
        source={{ kind: "advanced", input }}
        playlistKey={playlistKey}
        playlistTitle={`#${genre}`}
        headingPrefix={`#${genre}`}
      />
    </>
  );
}
