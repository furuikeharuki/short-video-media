"use client";

/**
 * 検索結果ページ専用のサブヘッダー (修正5)。
 *
 * 機能:
 * - 左: 戻るボタン (ブラウザ履歴 back) + 現在のキーワード/ジャンル表記
 * - 右: フィルターアイコン → 押下で詳細検索シートを開閉
 * - フィルター適用時:
 *   - 新しい /search?... URL に router.push
 *   - 適用したチップ/日付/ソートは
 *     - ログイン中: サーバ (PUT /me/search-prefs) に保存
 *     - 未ログイン: sessionStorage に保存
 *   - URL クエリと sessionStorage / サーバ保存値の優先関係:
 *     - URL クエリが空のフィールド → 復元値で埋める (検索結果ページ初回マウント時のみ)
 *     - URL クエリに値があるフィールド → URL を尊重
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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

/** sessionStorage に書き出すペイロード。サーバ payload と同じ形。 */
type StoredPref = {
  genres?: string[];
  actresses?: string[];
  series_list?: string[];
  directors?: string[];
  makers?: string[];
  labels?: string[];
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
    /* ignore (quota etc.) */
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
    genres: asStringArray(p.genres),
    actresses: asStringArray(p.actresses),
    series_list: asStringArray(p.series_list),
    directors: asStringArray(p.directors),
    makers: asStringArray(p.makers),
    labels: asStringArray(p.labels),
    date_from: typeof p.date_from === "string" ? p.date_from : "",
    date_to: typeof p.date_to === "string" ? p.date_to : "",
    sort: normalizeSort(p.sort),
  };
}

/** URL 上に存在している advanced 系クエリ (チップ/日付/ソート) を抜き出す。 */
function readFromUrl(sp: URLSearchParams): AdvancedFormInitial {
  const arr = (k: string) => sp.getAll(k).map((s) => s.trim()).filter(Boolean);
  return {
    genres: arr("genres"),
    actresses: arr("actresses"),
    series_list: arr("series_list"),
    directors: arr("directors"),
    makers: arr("makers"),
    labels: arr("labels"),
    date_from: (sp.get("date_from") ?? "").trim(),
    date_to: (sp.get("date_to") ?? "").trim(),
    sort: normalizeSort(sp.get("sort")),
  };
}

/** URL 由来の値が完全に空かどうか (= 復元で埋めて良いか) を判定する。 */
function isUrlAdvEmpty(init: AdvancedFormInitial): boolean {
  return (
    (init.genres?.length ?? 0) === 0 &&
    (init.actresses?.length ?? 0) === 0 &&
    (init.series_list?.length ?? 0) === 0 &&
    (init.directors?.length ?? 0) === 0 &&
    (init.makers?.length ?? 0) === 0 &&
    (init.labels?.length ?? 0) === 0 &&
    !init.date_from &&
    !init.date_to &&
    !init.sort
  );
}

type Props = {
  /** 左側に表示するラベル (例: "「妹」" / "#プロ女優" / "監督「苺原」")。空ならラベル省略。 */
  label: string;
  /** 詳細検索パネルが現在の /search?q= から拾ってくるキーワード。 */
  keyword: string;
};

export default function SearchResultsHeader({ label, keyword }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status } = useSession();
  const isAuthed = status === "authenticated";

  const [open, setOpen] = useState(false);
  // フィルターパネルに渡す初期値。URL > 復元 (サーバ/セッション) の優先。
  const [initial, setInitial] = useState<AdvancedFormInitial>(() =>
    readFromUrl(new URLSearchParams(searchParams?.toString() ?? ""))
  );

  // 初回マウント時のみ、URL に advanced 系の値が無ければサーバ or sessionStorage から復元。
  // パネルを開く前に initial を確定させておきたいので非同期で更新する。
  useEffect(() => {
    const urlInit = readFromUrl(new URLSearchParams(searchParams?.toString() ?? ""));
    if (!isUrlAdvEmpty(urlInit)) {
      // URL に値があるならそれを尊重 (パネルを開いたとき URL の状態を見せる)
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
    // searchParams の再評価で繰り返し走らせない: 初回マウントの値で固定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthed]);

  const handleBack = useCallback(() => {
    // ブラウザ履歴 back。直接アクセス等で履歴が無いケースに備えてフォールバック。
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push("/");
    }
  }, [router]);

  const handleSubmit = useCallback(
    (url: string, payload: AdvancedSubmitPayload) => {
      const stored: StoredPref = {
        genres: payload.genres,
        actresses: payload.actresses,
        series_list: payload.series_list,
        directors: payload.directors,
        makers: payload.makers,
        labels: payload.labels,
        date_from: payload.date_from,
        date_to: payload.date_to,
        sort: payload.sort,
      };
      // セッション保存は両モードで実施 (ログイン中も即時の UI 復元用)
      writeSessionPref(stored);
      // ログイン中ならサーバにも upsert (失敗は無視)
      if (isAuthed) {
        void putSearchPref({
          q: keyword || null,
          genres: payload.genres,
          actresses: payload.actresses,
          series_list: payload.series_list,
          directors: payload.directors,
          makers: payload.makers,
          labels: payload.labels,
          date_from: payload.date_from || null,
          date_to: payload.date_to || null,
          sort: payload.sort || null,
        });
      }
      setOpen(false);
      router.push(url);
    },
    [router, isAuthed, keyword]
  );

  const handleCancel = useCallback(() => setOpen(false), []);

  // 適用済みの絞り込み数 (バッジ表示用)。
  const activeCount = useMemo(() => {
    const c =
      (initial.genres?.length ?? 0) +
      (initial.actresses?.length ?? 0) +
      (initial.series_list?.length ?? 0) +
      (initial.directors?.length ?? 0) +
      (initial.makers?.length ?? 0) +
      (initial.labels?.length ?? 0) +
      (initial.date_from ? 1 : 0) +
      (initial.date_to ? 1 : 0) +
      (initial.sort ? 1 : 0);
    return c;
  }, [initial]);

  return (
    <>
      <div className="sr-subheader">
        <button
          type="button"
          className="sr-back-btn"
          aria-label="戻る"
          onClick={handleBack}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 6 9 12 15 18" />
          </svg>
        </button>
        <div className="sr-label" title={label}>{label}</div>
        <button
          type="button"
          className={`sr-filter-btn${activeCount > 0 ? " has-active" : ""}`}
          aria-label="絞り込み"
          aria-expanded={open}
          aria-controls="search-results-filter-sheet"
          onClick={() => setOpen((v) => !v)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="18" x2="20" y2="18" />
            <circle cx="9" cy="6" r="2.2" fill="#0a0a0a" />
            <circle cx="15" cy="12" r="2.2" fill="#0a0a0a" />
            <circle cx="8" cy="18" r="2.2" fill="#0a0a0a" />
          </svg>
          {activeCount > 0 && <span className="sr-filter-badge">{activeCount}</span>}
        </button>
      </div>

      {open && (
        <>
          {/* 背景クリックで閉じる用のオーバーレイ */}
          <div className="sr-sheet-backdrop" onClick={() => setOpen(false)} />
          <div
            id="search-results-filter-sheet"
            className="sr-sheet"
            role="dialog"
            aria-label="検索フィルター"
          >
            <AdvancedSearchPanel
              isAuthed={isAuthed}
              keyword={keyword}
              initial={initial}
              onSubmit={handleSubmit}
              onCancel={handleCancel}
            />
          </div>
        </>
      )}

      <style>{css}</style>
    </>
  );
}

const css = `
  .sr-subheader {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #0a0a0a;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    min-height: 44px;
  }
  .sr-back-btn,
  .sr-filter-btn {
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
  .sr-back-btn:hover,
  .sr-filter-btn:hover {
    background: rgba(255,255,255,0.08);
  }
  .sr-filter-btn.has-active {
    color: var(--accent, #e91e63);
  }
  .sr-filter-badge {
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
  .sr-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #fff;
    font-size: 14px;
    font-weight: 600;
  }
  .sr-sheet-backdrop {
    position: fixed;
    top: var(--header-h, 52px);
    left: 0;
    right: 0;
    bottom: var(--bottom-nav-h, 56px);
    background: rgba(0,0,0,0.5);
    z-index: 50;
  }
  .sr-sheet {
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
    animation: sr-sheet-in 0.18s ease-out;
  }
  @keyframes sr-sheet-in {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
  }
`;
