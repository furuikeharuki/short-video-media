"use client";

/**
 * /feed と /search 表示時に「設定済みフィルター」を強制適用するためのフック。
 *
 * 仕様:
 *   - URL に詳細検索系の値 (q / genres / actresses / ... / sort) が一切無いとき、
 *     sessionStorage (匿名) または /me/search-prefs (ログイン中) から読み出し、
 *     `router.replace` で URL クエリに注入する。
 *   - URL に既に何か乗っていれば「ユーザーが意図して開いた URL」として尊重し、何もしない。
 *   - /search の場合、文脈クエリ (q / genre / director / maker / label / series) は
 *     advanced クエリと AND で重なるので、それらが乗っていても advanced 系が無ければ
 *     保存済みフィルターを上乗せして適用する。
 *
 * GlobalFilterButton.tsx と同じ復元ソース (sessionStorage / server) を使うため、
 * 同一の SESSION_KEY / sort バリデーションを共有している。
 */
import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { getSearchPref } from "@/lib/api/me";
import type { SortKey } from "@/lib/api/search";

const SESSION_KEY = "search_prefs_v1";

const VALID_SORTS = new Set<SortKey>([
  "new",
  "popular",
  "rating",
  "views",
  "bookmarks",
]);

type StoredPref = {
  q?: string;
  genres?: string[];
  actresses?: string[];
  series_list?: string[];
  directors?: string[];
  makers?: string[];
  labels?: string[];
  ng_words?: string[];
  date_from?: string;
  date_to?: string;
  sort?: SortKey | "";
};

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string" && s.trim() !== "");
}

function normalizeSort(s: unknown): SortKey | "" {
  if (typeof s !== "string" || s === "") return "";
  return VALID_SORTS.has(s as SortKey) ? (s as SortKey) : "";
}

function readSessionPref(): StoredPref | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredPref;
  } catch {
    return null;
  }
}

/** stored pref が「実質空」かどうか。空のときは適用するものが無いので何もしない。 */
function isPrefEmpty(p: StoredPref | null): boolean {
  if (!p) return true;
  return (
    !(p.q && p.q.trim()) &&
    asStringArray(p.genres).length === 0 &&
    asStringArray(p.actresses).length === 0 &&
    asStringArray(p.series_list).length === 0 &&
    asStringArray(p.directors).length === 0 &&
    asStringArray(p.makers).length === 0 &&
    asStringArray(p.labels).length === 0 &&
    asStringArray(p.ng_words).length === 0 &&
    !(p.date_from && p.date_from.trim()) &&
    !(p.date_to && p.date_to.trim()) &&
    !normalizeSort(p.sort)
  );
}

/** URL に「advanced 系の値」が乗っているか。 */
function hasAdvancedInUrl(sp: URLSearchParams): boolean {
  const has = (k: string) => sp.getAll(k).some((v) => v.trim() !== "");
  return (
    (sp.get("q") ?? "").trim() !== "" ||
    has("genres") ||
    has("actresses") ||
    has("series_list") ||
    has("directors") ||
    has("makers") ||
    has("labels") ||
    has("ng_words") ||
    (sp.get("date_from") ?? "").trim() !== "" ||
    (sp.get("date_to") ?? "").trim() !== "" ||
    normalizeSort(sp.get("sort")) !== ""
  );
}

/** stored pref + 既存 URL params を合成して新しい URLSearchParams を作る。 */
function mergeIntoParams(base: URLSearchParams, pref: StoredPref): URLSearchParams {
  const params = new URLSearchParams(base.toString());

  const q = (pref.q ?? "").trim();
  // 既存に q があれば優先 (普通は無い: hasAdvancedInUrl 前提)
  if (q && !(params.get("q") ?? "").trim()) {
    params.set("q", q);
  }

  const setMulti = (key: string, values: string[]) => {
    // 既に同じキーが入ってないか念のため除去
    params.delete(key);
    const dedup = Array.from(new Set(values.map((s) => s.trim()).filter(Boolean)));
    for (const v of dedup) params.append(key, v);
  };
  if (asStringArray(pref.genres).length) setMulti("genres", asStringArray(pref.genres));
  if (asStringArray(pref.actresses).length) setMulti("actresses", asStringArray(pref.actresses));
  if (asStringArray(pref.series_list).length) setMulti("series_list", asStringArray(pref.series_list));
  if (asStringArray(pref.directors).length) setMulti("directors", asStringArray(pref.directors));
  if (asStringArray(pref.makers).length) setMulti("makers", asStringArray(pref.makers));
  if (asStringArray(pref.labels).length) setMulti("labels", asStringArray(pref.labels));
  if (asStringArray(pref.ng_words).length) setMulti("ng_words", asStringArray(pref.ng_words));

  if (pref.date_from && pref.date_from.trim()) params.set("date_from", pref.date_from.trim());
  if (pref.date_to && pref.date_to.trim()) params.set("date_to", pref.date_to.trim());

  const sort = normalizeSort(pref.sort);
  if (sort) params.set("sort", sort);

  return params;
}

/**
 * /feed か /search 配下にいるときだけ動く。それ以外のパスでは no-op。
 * pathname or URL が変わるたびに再判定するが、1 URL ごとに 1 度だけ replace する。
 */
export function useEnforceSavedFilter() {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const { status } = useSession();
  const isAuthed = status === "authenticated";
  // 同じ URL に対して二度 replace しないためのガード
  const lastHandledRef = useRef<string>("");

  const urlKey = searchParams?.toString() ?? "";
  const isTarget =
    pathname === "/feed" ||
    pathname.startsWith("/feed/") ||
    pathname === "/search" ||
    pathname.startsWith("/search/");

  useEffect(() => {
    if (!isTarget) return;
    // セッションロード判定が確定するまで待つ (authed のときはサーバ pref を優先)
    if (status === "loading") return;

    const handleKey = `${pathname}?${urlKey}`;
    if (lastHandledRef.current === handleKey) return;

    const sp = new URLSearchParams(urlKey);
    if (hasAdvancedInUrl(sp)) {
      lastHandledRef.current = handleKey;
      return;
    }

    let cancelled = false;
    (async () => {
      // 認証時はサーバ prefs を優先、未認証は session のみ
      let pref: StoredPref | null = null;
      if (isAuthed) {
        try {
          pref = (await getSearchPref()) as StoredPref;
        } catch {
          pref = null;
        }
      }
      if (!pref || isPrefEmpty(pref)) {
        // 認証時でもサーバが空 / 失敗のときは session fallback を見る
        pref = readSessionPref();
      }
      if (cancelled) return;
      lastHandledRef.current = handleKey;
      if (isPrefEmpty(pref)) return;

      const merged = mergeIntoParams(sp, pref!);
      const qs = merged.toString();
      const nextUrl = qs ? `${pathname}?${qs}` : pathname;
      // 同一 URL ならスキップ (理論上来ないが念のため)
      const currentUrl = urlKey ? `${pathname}?${urlKey}` : pathname;
      if (nextUrl === currentUrl) return;
      // history を増やさず差し替え
      router.replace(nextUrl);
    })();
    return () => {
      cancelled = true;
    };
  }, [isTarget, pathname, urlKey, isAuthed, status, router]);
}
