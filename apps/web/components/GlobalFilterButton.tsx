"use client";

/**
 * ヘッダー右側に置く「フィルター」アイコン + 詳細検索パネルのシート。
 *
 * - 表示するパス: `/search` と `/feed` (ショート動画) のみ
 * - クリックで AdvancedSearchPanel を右からスライドイン
 * - 適用時:
 *   - `/feed` 系のパスのときは `/feed` に戻る (フィルター適用済みのショート再生)
 *   - それ以外 (`/search` 系) は `/search?...` へ
 *   - 適用条件は sessionStorage + ログイン中はサーバ /me/search-prefs にも保存
 * - 初回マウント時に URL に advanced 系の値が無ければ、サーバ or sessionStorage から復元
 *
 * 注: 文脈クエリ (q / genre / director / maker / label / series の単一クエリ) の保持は
 *     `/search` の場合のみ行う。`/feed` で適用するときは URL に q をそのまま乗せる
 *     (=詳細検索パネル内のキーワード入力欄が真実のソース)。
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import AdvancedSearchPanel, {
  type AdvancedFormInitial,
  type AdvancedSubmitPayload,
} from "@/components/AdvancedSearchPanel";
import { getSearchPref, putSearchPref } from "@/lib/api/me";
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

function writeSessionPref(payload: StoredPref) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string" && s.trim() !== "");
}

function normalizeSort(s: unknown): SortKey | "" {
  if (typeof s !== "string" || s === "") return "";
  return VALID_SORTS.has(s as SortKey) ? (s as SortKey) : "";
}

function payloadToInitial(p: StoredPref | null): AdvancedFormInitial {
  if (!p) return {};
  return {
    q: typeof p.q === "string" ? p.q : "",
    genres: asStringArray(p.genres),
    actresses: asStringArray(p.actresses),
    series_list: asStringArray(p.series_list),
    directors: asStringArray(p.directors),
    makers: asStringArray(p.makers),
    labels: asStringArray(p.labels),
    ng_words: asStringArray(p.ng_words),
    date_from: typeof p.date_from === "string" ? p.date_from : "",
    date_to: typeof p.date_to === "string" ? p.date_to : "",
    sort: normalizeSort(p.sort),
  };
}

/** URL から advanced 系クエリ (チップ/NG/日付/ソート/q) を抜き出す。 */
function readFromUrl(sp: URLSearchParams): AdvancedFormInitial {
  const arr = (k: string) => sp.getAll(k).map((s) => s.trim()).filter(Boolean);
  return {
    q: (sp.get("q") ?? "").trim(),
    genres: arr("genres"),
    actresses: arr("actresses"),
    series_list: arr("series_list"),
    directors: arr("directors"),
    makers: arr("makers"),
    labels: arr("labels"),
    ng_words: arr("ng_words"),
    date_from: (sp.get("date_from") ?? "").trim(),
    date_to: (sp.get("date_to") ?? "").trim(),
    sort: normalizeSort(sp.get("sort")),
  };
}

/** URL に「フィルター指定がひとつも乗っていない」状態かどうかを判定。 */
function isUrlAdvEmpty(init: AdvancedFormInitial): boolean {
  return (
    !init.q &&
    (init.genres?.length ?? 0) === 0 &&
    (init.actresses?.length ?? 0) === 0 &&
    (init.series_list?.length ?? 0) === 0 &&
    (init.directors?.length ?? 0) === 0 &&
    (init.makers?.length ?? 0) === 0 &&
    (init.labels?.length ?? 0) === 0 &&
    (init.ng_words?.length ?? 0) === 0 &&
    !init.date_from &&
    !init.date_to &&
    !init.sort
  );
}

/** 適用済みフィルター数 (バッジ表示用)。 */
function countActive(init: AdvancedFormInitial): number {
  return (
    (init.q ? 1 : 0) +
    (init.genres?.length ?? 0) +
    (init.actresses?.length ?? 0) +
    (init.series_list?.length ?? 0) +
    (init.directors?.length ?? 0) +
    (init.makers?.length ?? 0) +
    (init.labels?.length ?? 0) +
    (init.ng_words?.length ?? 0) +
    (init.date_from ? 1 : 0) +
    (init.date_to ? 1 : 0) +
    (init.sort ? 1 : 0)
  );
}

/** `/genres/<genre>` のとき、URL デコード済みのジャンル名を返す。それ以外は null。
 *  ジャンル一覧 (`/genres` 単独) は対象外。 */
function genreFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/genres\/([^/]+)\/?$/);
  if (!m) return null;
  try {
    const g = decodeURIComponent(m[1]).trim();
    return g || null;
  } catch {
    return null;
  }
}

/** 適用先のパス判定。`/search` 以下 / `/feed` 以下 / `/genres/<genre>` のときだけアイコンを出す。
 *  ただし `/feed?playlist=<key>` (ブックマーク / 視聴履歴 / ホーム各セクション /
 *  女優詳細 / 検索結果カードからの再生) はプレイリスト順をそのまま再生する経路なので
 *  フィルターアイコンは出さず、フィルター自体も効かせない。
 *  ジャンルページ (index 可能な LP) では、詳細検索を適用すると現在のジャンルを
 *  AND 固定したまま `/search?genre=<genre>&...` へ遷移する (page.tsx が AND 合成する)。 */
function isFilterablePath(pathname: string, sp: URLSearchParams | null): boolean {
  const isFeed = pathname === "/feed" || pathname.startsWith("/feed/");
  const isSearch = pathname === "/search" || pathname.startsWith("/search/");
  const isGenre = genreFromPath(pathname) !== null;
  if (!isFeed && !isSearch && !isGenre) return false;
  if (isFeed) {
    const playlist = (sp?.get("playlist") ?? "").trim();
    if (playlist) return false;
  }
  return true;
}

/**
 * ルートレイアウトの Header で使うため、どのページの prerender 時にもマウントされる。
 * useSearchParams() を使うので Next.js 15 では Suspense バウンダリが必須 (CSR bailout を防ぐ)。
 */
export default function GlobalFilterButton() {
  return (
    <Suspense fallback={null}>
      <GlobalFilterButtonInner />
    </Suspense>
  );
}

function GlobalFilterButtonInner() {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const { status } = useSession();
  const isAuthed = status === "authenticated";

  const urlKey = searchParams?.toString() ?? "";
  const visible = isFilterablePath(pathname, searchParams);

  const [open, setOpen] = useState(false);
  const [initial, setInitial] = useState<AdvancedFormInitial>(() =>
    readFromUrl(new URLSearchParams(urlKey))
  );

  // URL に advanced 値があれば URL を尊重。無ければ復元ソース (server / session) から埋める。
  // URL が変わるたびに再評価して、適用直後にシートを開き直しても適用済みチップが見える。
  useEffect(() => {
    if (!visible) return; // 非表示画面なら復元処理も走らせない (無駄な fetch を抑える)
    const urlInit = readFromUrl(new URLSearchParams(urlKey));
    if (!isUrlAdvEmpty(urlInit)) {
      setInitial(urlInit);
      return;
    }
    let cancelled = false;
    (async () => {
      if (isAuthed) {
        const server = await getSearchPref();
        if (cancelled) return;
        setInitial(payloadToInitial(server as StoredPref));
      } else {
        const local = readSessionPref();
        setInitial(payloadToInitial(local));
      }
    })();
    return () => { cancelled = true; };
  }, [isAuthed, urlKey, visible]);

  // パスが変わったらシートは閉じる
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const activeCount = useMemo(() => countActive(initial), [initial]);

  const handleSubmit = useCallback(
    async (payload: AdvancedSubmitPayload) => {
      // セッションにも保存 (匿名でも次回起動で同じ条件を再現できるように)
      const stored: StoredPref = {
        q: payload.q,
        genres: payload.genres,
        actresses: payload.actresses,
        series_list: payload.series_list,
        directors: payload.directors,
        makers: payload.makers,
        labels: payload.labels,
        ng_words: payload.ng_words,
        date_from: payload.date_from,
        date_to: payload.date_to,
        sort: payload.sort,
      };
      writeSessionPref(stored);
      // サーバ保存は await する。これを fire-and-forget にしてしまうと、
      // 「クリアして適用」直後に useEnforceSavedFilter が走ったとき、まだ古い
      // サーバ pref を見て URL に再注入してしまい、クリアしたはずの条件が
      // 復活してしまう。await することで、router.push に進む前に必ず最新の
      // pref がサーバに反映された状態にする。
      if (isAuthed) {
        try {
          await putSearchPref({
            q: payload.q || null,
            genres: payload.genres,
            actresses: payload.actresses,
            series_list: payload.series_list,
            directors: payload.directors,
            makers: payload.makers,
            labels: payload.labels,
            ng_words: payload.ng_words,
            date_from: payload.date_from || null,
            date_to: payload.date_to || null,
            sort: payload.sort || null,
          });
        } catch {
          /* 保存失敗時もナビゲーションは続ける (session には書けている) */
        }
      }

      // URL を組み立てる。 /search でも /feed でも基本同じパラメータ。
      const params = new URLSearchParams();
      if (payload.q) params.set("q", payload.q);

      const appendMulti = (key: string, arr: string[]) => {
        const dedup = Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
        for (const v of dedup) params.append(key, v);
      };
      appendMulti("genres", payload.genres);
      appendMulti("actresses", payload.actresses);
      appendMulti("series_list", payload.series_list);
      appendMulti("directors", payload.directors);
      appendMulti("makers", payload.makers);
      appendMulti("labels", payload.labels);
      appendMulti("ng_words", payload.ng_words);
      if (payload.date_from) params.set("date_from", payload.date_from);
      if (payload.date_to) params.set("date_to", payload.date_to);
      if (payload.sort) params.set("sort", payload.sort);

      // ベースパス: /feed 系なら /feed 、それ以外は /search に集約
      const basePath = pathname.startsWith("/feed") ? "/feed" : "/search";

      // /search に来るときの「文脈クエリ」(サブヘッダーに #ハイビジョン や
      // 監督「〇〇」のラベルを表示するためのキー) は、フィルター適用後も
      // 維持しないとサブヘッダーが消えてしまう。現在の URL から拾って残す。
      // - /feed では文脈クエリ自体を扱わないので何もしない。
      // - payload.q がある場合は単独 q を上書きするので、文脈の q だけは入れない。
      if (basePath === "/search") {
        const currentParams = new URLSearchParams(urlKey);
        const contextKeys = ["genre", "director", "maker", "label", "series"] as const;
        for (const key of contextKeys) {
          const v = (currentParams.get(key) ?? "").trim();
          if (v && !params.has(key)) params.set(key, v);
        }
        // ジャンルページ (`/genres/<genre>`) から適用した場合は、そのジャンルを
        // genre 文脈クエリとして注入する。/search?genre=<genre>&... の形になり、
        // page.tsx 側で「genre を AND 固定したまま詳細検索条件を AND」する。
        const pageGenre = genreFromPath(pathname);
        if (pageGenre && !params.has("genre")) params.set("genre", pageGenre);
        // 単独 q (キーワード文脈)。payload.q が空のときだけ復元する。
        if (!params.get("q")) {
          const ctxQ = (currentParams.get("q") ?? "").trim();
          if (ctxQ) params.set("q", ctxQ);
        }
      }
      const qs = params.toString();
      const nextUrl = qs ? `${basePath}?${qs}` : basePath;

      setOpen(false);
      // /feed (ショート動画) から適用したときは、必ずフルページ遷移で再ロードする。
      // 理由: /feed は @modal 並列ルート / pushState / <video> ライフサイクル副作用で
      // SPA 遷移時の searchParams 反映が不安定で、適用ボタンを押しても新条件で
      // ロードし直されない (= 即時反映されない) ことが起きていた。
      // ユーザ要望 "ショート動画画面をリロードでいいかも" に合わせて、/feed では
      // 常に window.location.assign で確実にフィードを再起動させる。
      const isFeed = pathname === "/feed" || pathname.startsWith("/feed/");
      if (isFeed) {
        if (typeof window !== "undefined") {
          // 適用直後のフルリロード前に、前回のフィードセッションを完全に破棄する。
          // これにより新しい /feed?... の URL でマウントした FeedClient は
          // 前回 sig 一致の検出に絶対に引っかからず、必ず新条件で fetch → 0 件のとき
          // 「該当する作品が見つかりませんでした」を確実に出す。
          try {
            sessionStorage.removeItem("feed_seed");
            sessionStorage.removeItem("feed_index");
            sessionStorage.removeItem("feed_items");
            sessionStorage.removeItem("feed_filter_sig");
            sessionStorage.removeItem("feed_next_cursor");
          } catch {
            /* ignore */
          }
          window.location.assign(nextUrl);
        } else {
          router.replace(nextUrl);
        }
        return;
      }

      // /search 系: 同一 URL でも navigation を強制したいので、現在の URL と差分が
      // 無い場合は hard navigation で確実に状態をクリア&再フェッチさせる。
      const currentSearch = urlKey ? `?${urlKey}` : "";
      const currentUrl = `${pathname}${currentSearch}`;
      if (nextUrl === currentUrl) {
        if (typeof window !== "undefined") {
          window.location.assign(nextUrl);
        } else {
          router.replace(nextUrl);
        }
      } else {
        router.push(nextUrl);
      }
    },
    [router, isAuthed, pathname, urlKey]
  );

  const handleClose = useCallback(() => setOpen(false), []);

  if (!visible) return null;

  return (
    <>
      <button
        type="button"
        className={`gf-btn${activeCount > 0 ? " has-active" : ""}`}
        aria-label="絞り込み"
        aria-expanded={open}
        aria-controls="global-filter-sheet"
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <line x1="4" y1="6" x2="20" y2="6" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="18" x2="20" y2="18" />
          <circle cx="9" cy="6" r="2.2" fill="#000" />
          <circle cx="15" cy="12" r="2.2" fill="#000" />
          <circle cx="8" cy="18" r="2.2" fill="#000" />
        </svg>
        {activeCount > 0 && <span className="gf-badge">{activeCount}</span>}
      </button>

      {open && (
        <>
          <div className="gf-backdrop" onClick={() => setOpen(false)} />
          <div
            id="global-filter-sheet"
            className="gf-sheet"
            role="dialog"
            aria-label="検索フィルター"
          >
            <AdvancedSearchPanel
              initial={initial}
              onSubmit={handleSubmit}
              onClose={handleClose}
            />
          </div>
        </>
      )}

      <style>{css}</style>
    </>
  );
}

const css = `
  .gf-btn {
    background: transparent;
    border: none;
    color: #fff;
    width: 36px;
    height: 36px;
    border-radius: 8px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    position: relative;
    flex-shrink: 0;
    -webkit-tap-highlight-color: transparent;
  }
  .gf-btn:hover {
    background: rgba(255,255,255,0.08);
  }
  .gf-btn.has-active {
    color: var(--accent, #e91e63);
  }
  .gf-badge {
    position: absolute;
    top: 2px;
    right: 2px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    background: var(--accent, #e91e63);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    line-height: 16px;
    border-radius: 999px;
    text-align: center;
  }
  .gf-backdrop {
    position: fixed;
    top: var(--header-h, 52px);
    left: 0;
    right: 0;
    bottom: var(--bottom-nav-h, 56px);
    background: rgba(0,0,0,0.5);
    z-index: 50;
  }
  .gf-sheet {
    position: fixed;
    top: var(--header-h, 52px);
    right: 0;
    width: min(360px, 92vw);
    height: calc(100dvh - var(--header-h, 52px) - var(--bottom-nav-h, 56px));
    background: #121212;
    color: #fff;
    z-index: 51;
    overflow-y: auto;
    overscroll-behavior: contain;
    box-shadow: -8px 0 24px rgba(0,0,0,0.5);
    animation: gf-sheet-in 0.18s ease-out;
  }
  @keyframes gf-sheet-in {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
  }
`;
