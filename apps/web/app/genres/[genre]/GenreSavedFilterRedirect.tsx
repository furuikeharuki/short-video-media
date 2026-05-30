"use client";

/**
 * ジャンル LP (`/genres/<genre>`) を開いたとき、ユーザーが以前設定した詳細検索条件が
 * あれば「現在のジャンルを AND 固定したまま」その条件を適用した結果へ自動遷移させる。
 *
 * 背景:
 *   - ジャンル LP は ISR (全ユーザー共通キャッシュ) の SSR ページなので、ユーザー個別の
 *     保存済み詳細検索条件 (sessionStorage / サーバ /me/search-prefs) を SSR では読めない。
 *   - LP 自体は初期 30 件のみの静的ページで、31 件目以降の追加ロードや詳細検索の
 *     絞り込みは行わない (= LP 上では詳細検索が効かない)。
 *   - そこで、保存済み条件がある場合のみクライアントで検知し、`/search?genre=<genre>&...`
 *     へ `router.replace` する。/search は genre を AND 固定したまま詳細検索条件を
 *     掛け合わせ、無限スクロールでも条件を維持する既存の正しい経路。
 *
 * 保存済み条件が無いユーザーは LP にそのまま留まる (= index 可能な親ジャンルページ)。
 *
 * 認証状態:
 *   - ログイン中: サーバ /me/search-prefs を優先 (端末をまたいで同じ条件)。空ならセッション。
 *   - 未ログイン: sessionStorage のみ。
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { getSearchPref } from "@/lib/api/me";
import {
  readSavedSearchPref,
  type SavedSearchPref,
} from "@/lib/savedSearchPrefs";

const VALID_SORTS = new Set(["new", "popular", "rating", "views", "bookmarks"]);

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
  if (sort && VALID_SORTS.has(sort)) cleaned.sort = sort;

  if (
    !cleaned.q &&
    !cleaned.genres &&
    !cleaned.actresses &&
    !cleaned.series_list &&
    !cleaned.directors &&
    !cleaned.makers &&
    !cleaned.labels &&
    !cleaned.ng_words &&
    !cleaned.date_from &&
    !cleaned.date_to &&
    !cleaned.sort
  ) {
    return null;
  }
  return cleaned;
}

/** 保存済み条件 + 現在ジャンルから `/search?genre=<genre>&...` を組み立てる。
 *  genre は文脈クエリとして付与し、/search 側で詳細検索条件と AND 合成される。 */
function buildSearchHref(genre: string, pref: SavedSearchPref): string {
  const params = new URLSearchParams();
  params.set("genre", genre);
  if (pref.q) params.set("q", pref.q);
  const appendMulti = (key: string, arr: string[] | undefined) => {
    if (!arr) return;
    for (const v of arr) params.append(key, v);
  };
  appendMulti("genres", pref.genres);
  appendMulti("actresses", pref.actresses);
  appendMulti("series_list", pref.series_list);
  appendMulti("directors", pref.directors);
  appendMulti("makers", pref.makers);
  appendMulti("labels", pref.labels);
  appendMulti("ng_words", pref.ng_words);
  if (pref.date_from) params.set("date_from", pref.date_from);
  if (pref.date_to) params.set("date_to", pref.date_to);
  if (pref.sort) params.set("sort", pref.sort);
  return `/search?${params.toString()}`;
}

export default function GenreSavedFilterRedirect({ genre }: { genre: string }) {
  const router = useRouter();
  const { status } = useSession();
  // 1 マウントにつき 1 度だけ判定/遷移する。
  const handledRef = useRef(false);

  useEffect(() => {
    if (handledRef.current) return;
    // セッション確定前は待つ (authed のときはサーバ pref を優先したいため)。
    if (status === "loading") return;

    let cancelled = false;
    (async () => {
      let pref: SavedSearchPref | null = null;
      if (status === "authenticated") {
        try {
          pref = normalizeServerPref(await getSearchPref());
        } catch {
          pref = null;
        }
      }
      // サーバが空 / 未ログインのときは sessionStorage を見る。
      if (!pref) {
        pref = readSavedSearchPref();
      }
      if (cancelled) return;
      handledRef.current = true;
      if (!pref) return; // 保存済み条件なし → LP に留まる。

      router.replace(buildSearchHref(genre, pref));
    })();

    return () => {
      cancelled = true;
    };
  }, [genre, status, router]);

  return null;
}
