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
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { getSearchPref } from "@/lib/api/me";
import type { SortKey } from "@/lib/api/search";
import type { SavedFilterStatus } from "@/components/SavedFilterContext";

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

/** URL に「詳細検索系の絞り込み値」(配列系 / date / sort) が乗っているか。
 *  q は意図的に含めない: 検索アイコンからの `/search?q=foo` でも保存済み詳細条件を
 *  AND 注入したいので、q が乗っているだけでは「URL は完成済み」とは見なさない。
 */
function hasAdvancedInUrl(sp: URLSearchParams): boolean {
  const has = (k: string) => sp.getAll(k).some((v) => v.trim() !== "");
  return (
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

/** stored pref + 既存 URL params を合成して新しい URLSearchParams を作る。
 *
 *  - q: URL に q が既にあれば (検索アイコンからの検索) URL を尊重しつつ
 *       保存済み q とは AND になるが、URL に乗せる q は 1 つだけなので
 *       URL の q を維持する (保存済み q は他の保存済み条件と一緒に
 *       上乗せされた配列条件で AND 効果が出る前提)。
 *       URL に q が無ければ保存済み q を注入する。
 *       タグ文脈がある場合でも q は注入する: 表示ラベルは page.tsx 側で
 *       タグ文脈を優先するので、注入された q は検索条件にのみ効く。
 *  - 配列系 (genres / actresses / ...): URL に既にそのキーがあれば
 *       URL を尊重して上書きしない (非破壊)。URL がそのキーを持たない
 *       場合のみ保存済みを注入する。これによりタグ遷移や検索アイコン経由でも
 *       URL に未設定の保存済み条件が AND で効くようになる。
 */
function mergeIntoParams(base: URLSearchParams, pref: StoredPref): URLSearchParams {
  const params = new URLSearchParams(base.toString());

  const q = (pref.q ?? "").trim();
  if (q && !(params.get("q") ?? "").trim()) {
    params.set("q", q);
  }

  const setMultiIfEmpty = (key: string, values: string[]) => {
    const existing = params.getAll(key).some((v) => v.trim() !== "");
    if (existing) return; // URL の値を尊重 (上書きしない)
    const dedup = Array.from(new Set(values.map((s) => s.trim()).filter(Boolean)));
    if (!dedup.length) return;
    params.delete(key);
    for (const v of dedup) params.append(key, v);
  };
  if (asStringArray(pref.genres).length) setMultiIfEmpty("genres", asStringArray(pref.genres));
  if (asStringArray(pref.actresses).length) setMultiIfEmpty("actresses", asStringArray(pref.actresses));
  if (asStringArray(pref.series_list).length) setMultiIfEmpty("series_list", asStringArray(pref.series_list));
  if (asStringArray(pref.directors).length) setMultiIfEmpty("directors", asStringArray(pref.directors));
  if (asStringArray(pref.makers).length) setMultiIfEmpty("makers", asStringArray(pref.makers));
  if (asStringArray(pref.labels).length) setMultiIfEmpty("labels", asStringArray(pref.labels));
  if (asStringArray(pref.ng_words).length) setMultiIfEmpty("ng_words", asStringArray(pref.ng_words));

  if (pref.date_from && pref.date_from.trim() && !(params.get("date_from") ?? "").trim()) {
    params.set("date_from", pref.date_from.trim());
  }
  if (pref.date_to && pref.date_to.trim() && !(params.get("date_to") ?? "").trim()) {
    params.set("date_to", pref.date_to.trim());
  }

  const sort = normalizeSort(pref.sort);
  if (sort && !normalizeSort(params.get("sort"))) {
    params.set("sort", sort);
  }

  return params;
}

/**
 * /feed か /search 配下にいるときだけ動く。それ以外のパスでは no-op。
 * pathname or URL が変わるたびに再判定するが、1 URL ごとに 1 度だけ replace する。
 *
 * 戻り値の status:
 *   - "pending": /feed ・ /search で saved pref を読み / URL に注入するか判定中。
 *     コンテンツ側はこの間表示を押さえると "フィルター違反作品が一瞬見える" フラッシュを防げる。
 *   - "ready":   URL が確定した / そもそも enforce 対象パスでない状態。
 */
export function useEnforceSavedFilter(): SavedFilterStatus {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const { status } = useSession();
  const isAuthed = status === "authenticated";
  // 同じ URL に対して二度 replace しないためのガード
  const lastHandledRef = useRef<string>("");
  // コンテンツ側で「表示してよいか」を判断するための状態。
  // pending の間はスピナーを見せるなどして、フィルター違反作品を一瞬も見せないようにする。
  const [enforceStatus, setEnforceStatus] = useState<SavedFilterStatus>("pending");

  const urlKey = searchParams?.toString() ?? "";
  // `/feed?playlist=<key>` (ブックマーク / 視聴履歴 / ホーム各セクション /
  // 女優詳細 / 検索結果カードからの再生) は "プレイリスト順をそのまま見せる経路"。
  // フィルターを強制適用するとプレイリストが上書きされてしまうので、ready 固定で no-op にする。
  const isFeedPlaylist =
    (pathname === "/feed" || pathname.startsWith("/feed/")) &&
    (new URLSearchParams(urlKey).get("playlist") ?? "").trim() !== "";
  const isTarget =
    !isFeedPlaylist &&
    (pathname === "/feed" ||
      pathname.startsWith("/feed/") ||
      pathname === "/search" ||
      pathname.startsWith("/search/"));

  useEffect(() => {
    // enforce 対象外のパスにいるときは「何もしない」と同義なので ready にしておく。
    if (!isTarget) {
      setEnforceStatus("ready");
      return;
    }
    // セッションロード判定が確定するまで待つ (authed のときはサーバ pref を優先)
    if (status === "loading") {
      setEnforceStatus("pending");
      return;
    }

    const handleKey = `${pathname}?${urlKey}`;
    if (lastHandledRef.current === handleKey) {
      // この URL は既に判定済み → 安定しているので ready
      setEnforceStatus("ready");
      return;
    }

    const sp = new URLSearchParams(urlKey);
    if (hasAdvancedInUrl(sp)) {
      // URL に既に advanced が乗っている → この URL をそのまま使うだけなので ready
      lastHandledRef.current = handleKey;
      setEnforceStatus("ready");
      return;
    }

    // ここからは「pref を読んで URL を replace するか判断する」フェーズ。
    // コンテンツを見せるのはこれが終わってからにしたいので pending に下げる。
    setEnforceStatus("pending");

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
      if (isPrefEmpty(pref)) {
        // 何も注入しない = この URL で ready
        setEnforceStatus("ready");
        return;
      }

      const merged = mergeIntoParams(sp, pref!);
      const qs = merged.toString();
      const nextUrl = qs ? `${pathname}?${qs}` : pathname;
      // 同一 URL ならスキップ (理論上来ないが念のため)
      const currentUrl = urlKey ? `${pathname}?${urlKey}` : pathname;
      if (nextUrl === currentUrl) {
        setEnforceStatus("ready");
        return;
      }
      // history を増やさず差し替え。遷移後の URL で useEffect が再走し
      // hasAdvancedInUrl=true パスに入りステータスはそこで ready になるので、
      // ここでは setEnforceStatus("ready") しない。
      router.replace(nextUrl);
    })();
    return () => {
      cancelled = true;
    };
  }, [isTarget, pathname, urlKey, isAuthed, status, router]);

  // render フェーズで「直前のレンダーでまだ処理していない URL」なら
  // 同期的に "pending" を返す。これにより、ホーム/マイページから /feed に
  // 戻ってきたときに、SavedFilterEnforcer が前ページ滞在中に "ready" にしていた
  // 値を持ち越して、FeedClient のマウント直後 1 回目の useEffect が
  // 「フィルター無しで fetch」してしまう不具合を防ぐ。
  //
  // useEffect 内の setEnforceStatus("pending") は次レンダーまで反映されないため、
  // マウント直後のレンダーで FeedClient に渡る Context value は前回の "ready" の
  // ままになりうる。ここで派生計算して同期的に "pending" を返すことで、
  // 「URL 確定前は絶対に fetch しない」契約を厳密に守れる。
  if (isTarget && status !== "loading") {
    const handleKey = `${pathname}?${urlKey}`;
    if (lastHandledRef.current !== handleKey) {
      const sp = new URLSearchParams(urlKey);
      if (!hasAdvancedInUrl(sp)) {
        // URL に advanced が乗っていない & まだ処理済みでない → pref 注入の
        // 可能性があるので確実に "pending" を返す
        return "pending";
      }
      // URL に advanced が乗っているので即 ready 扱いでよい
      return "ready";
    }
  }

  return enforceStatus;
}
