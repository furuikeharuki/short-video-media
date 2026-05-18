"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import FeedViewer from "@/components/FeedViewer";
import { markSeen, getOrCreateSeed } from "@/lib/feedOrder";
import { getFeed, type FeedAdvancedParams } from "@/lib/api/feed";
import { getHomeSection, type HomeSectionKey } from "@/lib/api/homeSection";
import { getMovieBySlug } from "@/lib/api/movies";
import { loadPlaylist, clearPlaylist, type PlaylistSource } from "@/lib/feedPlaylist";
import { logEvent } from "@/lib/api/events";
import { recordView } from "@/lib/api/me";
import type { MovieCard } from "@/lib/api/feed";
import type { MovieDetail } from "@/lib/api/movies";

const FEED_SEED_KEY   = "feed_seed";
const FEED_INDEX_KEY  = "feed_index";
const FEED_ITEMS_KEY  = "feed_items";
const FEED_CURSOR_KEY = "feed_next_cursor";
// 現在 sessionStorage に保存しているフィードの「フィルタ署名」。
// URL クエリが変わった (=フィルター適用が変わった) のを検知するためのキー。
const FEED_FILTER_KEY = "feed_filter_sig";

function saveSession(
  seed: number,
  index: number,
  items: object[],
  nextCursor: string | null,
  filterSig: string,
) {
  try {
    sessionStorage.setItem(FEED_SEED_KEY,  String(seed));
    sessionStorage.setItem(FEED_INDEX_KEY, String(index));
    sessionStorage.setItem(FEED_ITEMS_KEY, JSON.stringify(items));
    sessionStorage.setItem(FEED_FILTER_KEY, filterSig);
    if (nextCursor !== null) sessionStorage.setItem(FEED_CURSOR_KEY, nextCursor);
    else                     sessionStorage.removeItem(FEED_CURSOR_KEY);
  } catch { /* ignore */ }
}

function loadSession(): {
  seed: number;
  index: number;
  items: object[];
  nextCursor: string | null;
  filterSig: string;
} | null {
  try {
    const seed  = sessionStorage.getItem(FEED_SEED_KEY);
    const index = sessionStorage.getItem(FEED_INDEX_KEY);
    const items = sessionStorage.getItem(FEED_ITEMS_KEY);
    if (!seed || !index || !items) return null;
    return {
      seed:  parseInt(seed, 10),
      index: parseInt(index, 10),
      items: JSON.parse(items),
      nextCursor: sessionStorage.getItem(FEED_CURSOR_KEY),
      filterSig: sessionStorage.getItem(FEED_FILTER_KEY) ?? "",
    };
  } catch { return null; }
}

function clearFeedSession() {
  try {
    sessionStorage.removeItem(FEED_SEED_KEY);
    sessionStorage.removeItem(FEED_INDEX_KEY);
    sessionStorage.removeItem(FEED_ITEMS_KEY);
    sessionStorage.removeItem(FEED_CURSOR_KEY);
    sessionStorage.removeItem(FEED_FILTER_KEY);
  } catch { /* ignore */ }
}

function isPageReload(): boolean {
  try {
    const entries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    if (entries.length > 0) return entries[0].type === "reload";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (performance as any).navigation?.type === 1;
  } catch { return false; }
}

function movieDetailToCard(m: MovieDetail): MovieCard {
  return {
    id: m.id,
    content_id: m.content_id,
    title: m.title,
    slug: m.slug,
    image_url_list: m.image_url_list,
    image_url_large: m.image_url_large,
    sample_movie_url: m.sample_movie_url,
    affiliate_url: m.affiliate_url,
    price_list: m.price_list,
    price_min: m.price_min,
    review_count: m.review_count,
    review_average: m.review_average,
    actresses: m.actresses,
    genres: m.genres,
    series_name: m.series_name,
  };
}

// section key のホワイトリスト。サーバーと揃えておく。
const SECTION_KEYS: ReadonlySet<HomeSectionKey> = new Set<HomeSectionKey>([
  "popular",
  "new",
  "recent",
  "ranking_daily",
  "ranking_weekly",
  "ranking_monthly",
  "genre",
]);

/** URL から advanced 系クエリと genres を抜き出す。 */
function readFilters(sp: URLSearchParams): {
  genres: string[];
  advanced: FeedAdvancedParams;
  hasAny: boolean;
} {
  const arr = (k: string) => sp.getAll(k).map((s) => s.trim()).filter(Boolean);
  const genres = arr("genres");
  const advanced: FeedAdvancedParams = {
    q: (sp.get("q") ?? "").trim() || undefined,
    actresses: arr("actresses"),
    series_list: arr("series_list"),
    directors: arr("directors"),
    makers: arr("makers"),
    labels: arr("labels"),
    ng_words: arr("ng_words"),
    date_from: (sp.get("date_from") ?? "").trim() || undefined,
    date_to: (sp.get("date_to") ?? "").trim() || undefined,
  };
  const hasAny =
    genres.length > 0 ||
    !!advanced.q ||
    (advanced.actresses?.length ?? 0) > 0 ||
    (advanced.series_list?.length ?? 0) > 0 ||
    (advanced.directors?.length ?? 0) > 0 ||
    (advanced.makers?.length ?? 0) > 0 ||
    (advanced.labels?.length ?? 0) > 0 ||
    (advanced.ng_words?.length ?? 0) > 0 ||
    !!advanced.date_from ||
    !!advanced.date_to;
  return { genres, advanced, hasAny };
}

/** フィルター内容を安定文字列化して、URL 変化検知のキーにする。 */
function filterSignature(genres: string[], advanced: FeedAdvancedParams): string {
  const norm = {
    g: [...genres].sort(),
    q: advanced.q ?? "",
    a: [...(advanced.actresses ?? [])].sort(),
    sl: [...(advanced.series_list ?? [])].sort(),
    d: [...(advanced.directors ?? [])].sort(),
    m: [...(advanced.makers ?? [])].sort(),
    l: [...(advanced.labels ?? [])].sort(),
    n: [...(advanced.ng_words ?? [])].sort(),
    df: advanced.date_from ?? "",
    dt: advanced.date_to ?? "",
  };
  return JSON.stringify(norm);
}

export default function FeedClient() {
  const searchParams  = useSearchParams();
  const { status: authStatus } = useSession();
  const seedRef       = useRef<number | null>(null);
  const isFetchingRef = useRef(false);
  const isFetchingMoreRef = useRef(false);
  const nextCursorRef = useRef<string | null>(null);
  // playlist 経由で起動したときは /api/v1/home/section で継足しするため、
  // その出所情報 (セクション key / ジャンル名) を保持する。
  const playlistSourceRef = useRef<PlaylistSource | null>(null);
  // 現在のフィルター内容を ref で保持して、fetchMore からも参照できるようにする。
  const filtersRef = useRef<{ genres: string[]; advanced: FeedAdvancedParams }>({
    genres: [],
    advanced: {},
  });

  const [items,        setItems]        = useState<MovieCard[]>([]);
  const [initialIndex, setInitialIndex] = useState(0);
  const [isEmpty,      setIsEmpty]      = useState(false);
  const [isLoading,    setIsLoading]    = useState(true);

  // searchParams から現在のフィルターと署名を計算しておく。
  const { currentGenres, currentAdvanced, currentSig, hasAnyFilter } = useMemo(() => {
    const sp = new URLSearchParams(searchParams?.toString() ?? "");
    const { genres, advanced, hasAny } = readFilters(sp);
    return {
      currentGenres: genres,
      currentAdvanced: advanced,
      currentSig: filterSignature(genres, advanced),
      hasAnyFilter: hasAny,
    };
  }, [searchParams]);

  const fetchInitial = useCallback(async (
    seed: number,
    startIndex = 0,
    prependSlug?: string,
    genres?: string[],
    advanced?: FeedAdvancedParams,
    filterSig = "",
  ) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      const [res, pinnedMovie] = await Promise.all([
        getFeed(0, 20, seed, genres, advanced),
        prependSlug ? getMovieBySlug(prependSlug).catch(() => null) : Promise.resolve(null),
      ]);

      let feedItems = res.items;

      if (pinnedMovie) {
        const card = movieDetailToCard(pinnedMovie);
        // 重複排除して先頭に差し込む
        feedItems = [card, ...feedItems.filter((i) => i.slug !== card.slug)];
      }

      const idx = Math.min(startIndex, Math.max(feedItems.length - 1, 0));
      setItems(feedItems);
      setInitialIndex(idx);
      setIsEmpty(feedItems.length === 0);
      nextCursorRef.current = res.next_cursor;
      saveSession(seed, idx, feedItems, res.next_cursor, filterSig);
    } catch (e) {
      console.error("fetchInitial failed", e);
    } finally {
      isFetchingRef.current = false;
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // フィルター ref を最新に更新 (fetchMore から参照される)
    filtersRef.current = { genres: currentGenres, advanced: currentAdvanced };

    // /feed 上で MovieDetailModal を開くと window.history.pushState で URL バーが
    // /movies/<slug> に書き換わる。Next.js 15 ではこの pushState を router が検知し、
    // useSearchParams() が空文字列を返すようになるため、ここでの currentSig が変わって
    // しまい意図せず再フェッチが走り「別の feed が始まる」ように見えてしまう。
    // モーダル open/close で URL バーが一時的に /movies/ 系に切り替わっている間は
    // フィードの再ロードを抑止する。
    if (
      typeof window !== "undefined" &&
      !window.location.pathname.startsWith("/feed")
    ) {
      return;
    }

    const vSlug = searchParams.get("v") ?? undefined;
    const playlistKey = searchParams.get("playlist") ?? undefined;

    // ?playlist=<key> がある場合は sessionStorage に保存されたリストをそのまま使う
    // (API を叩かず、セクションの順番をそのまま再現する)
    if (playlistKey) {
      const pl = loadPlaylist(playlistKey);
      if (pl && pl.items.length > 0) {
        const seed = getOrCreateSeed();
        seedRef.current = seed;
        const idx = Math.min(Math.max(pl.startIndex, 0), pl.items.length - 1);
        setItems(pl.items);
        setInitialIndex(idx);
        setIsEmpty(false);
        setIsLoading(false);
        // source があれば 20 件以降も /api/v1/home/section で同じ順で取りにいく。
        // そのとき next_cursor は items.length を offset として使う。
        if (pl.source && SECTION_KEYS.has(pl.source.key as HomeSectionKey)) {
          playlistSourceRef.current = pl.source;
          nextCursorRef.current = String(pl.items.length);
        } else {
          playlistSourceRef.current = null;
          nextCursorRef.current = null;
        }
        saveSession(seed, idx, pl.items, nextCursorRef.current, currentSig);
        // 遷移後は一度だけ使えればよいのでクリア
        clearPlaylist(playlistKey);
        return;
      }
      // playlist が見つからないときは通常のフィードにフォールバック
    }

    // ?v= がある場合は常に新鮮なフィードを取得（先頭に該当動画を差し込む）
    if (vSlug) {
      const seed = getOrCreateSeed();
      seedRef.current = seed;
      fetchInitial(
        seed,
        0,
        vSlug,
        currentGenres.length > 0 ? currentGenres : undefined,
        hasAnyFilter ? currentAdvanced : undefined,
        currentSig,
      );
      return;
    }

    if (isPageReload()) {
      clearFeedSession();
      const seed = getOrCreateSeed();
      seedRef.current = seed;
      fetchInitial(
        seed,
        0,
        undefined,
        currentGenres.length > 0 ? currentGenres : undefined,
        hasAnyFilter ? currentAdvanced : undefined,
        currentSig,
      );
      return;
    }

    const session = loadSession();
    // フィルター署名が一致しているときだけセッションを復元、変わっていたら再 fetch
    if (
      session &&
      session.items.length > 0 &&
      session.filterSig === currentSig
    ) {
      seedRef.current = session.seed;
      const idx = Math.min(session.index, (session.items as MovieCard[]).length - 1);
      setItems(session.items as MovieCard[]);
      setInitialIndex(idx);
      setIsEmpty(false);
      setIsLoading(false);
      nextCursorRef.current = session.nextCursor;
    } else {
      // 既存セッションがあってもフィルターが違うので破棄して再 fetch する
      if (session) clearFeedSession();
      const seed = getOrCreateSeed();
      seedRef.current = seed;
      // フィルターが変わった瞬間に画面のチラつきを抑えるためロード中表示に戻す
      setIsLoading(true);
      setItems([]);
      setIsEmpty(false);
      fetchInitial(
        seed,
        0,
        undefined,
        currentGenres.length > 0 ? currentGenres : undefined,
        hasAnyFilter ? currentAdvanced : undefined,
        currentSig,
      );
    }
  // currentSig が変わったらフィルター適用扱いで再フェッチさせる
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSig]);

  // 追加ページを取得して items に append する。
  // FeedViewer は残り 5 件以下になったとき onNearEnd を引いてくるので、
  // ここで next_cursor を offset に訳して逆引して、重複除去のうえで末尾に足す。
  // playlist 経由や、API が next_cursor=null を返した (末尾到達) ときは何もしない。
  const fetchMore = useCallback(async () => {
    if (isFetchingMoreRef.current) return;
    const cursor = nextCursorRef.current;
    if (!cursor) return;
    const offset = parseInt(cursor, 10);
    if (Number.isNaN(offset)) return;

    // セッション (ホームの "ランキング" "人気" "ジャンル" など) 経由のときは
    // /api/v1/home/section で同じ順番で続けて取りにいく。
    // それ以外 (ふつうの /feed) は従来通り seed と offset で /feed を叩く。
    const source = playlistSourceRef.current;
    const seed = seedRef.current;

    isFetchingMoreRef.current = true;
    try {
      let resItems: MovieCard[];
      let resCursor: string | null;

      if (source) {
        const res = await getHomeSection(
          source.key as HomeSectionKey,
          offset,
          20,
          source.genre,
        );
        resItems = res.items;
        resCursor = res.next_cursor;
      } else {
        if (seed === null) return;
        const { genres, advanced } = filtersRef.current;
        const hasAdvanced =
          !!advanced.q ||
          (advanced.actresses?.length ?? 0) > 0 ||
          (advanced.series_list?.length ?? 0) > 0 ||
          (advanced.directors?.length ?? 0) > 0 ||
          (advanced.makers?.length ?? 0) > 0 ||
          (advanced.labels?.length ?? 0) > 0 ||
          (advanced.ng_words?.length ?? 0) > 0 ||
          !!advanced.date_from ||
          !!advanced.date_to;
        const res = await getFeed(
          offset,
          20,
          seed,
          genres.length > 0 ? genres : undefined,
          hasAdvanced ? advanced : undefined,
        );
        resItems = res.items;
        resCursor = res.next_cursor;
      }

      nextCursorRef.current = resCursor;
      if (resItems.length === 0) return;
      setItems((prev) => {
        const existing = new Set(prev.map((i) => i.id));
        const fresh    = resItems.filter((i) => !existing.has(i.id));
        if (fresh.length === 0) return prev;
        const merged = [...prev, ...fresh];
        // セッションの items も更新して、モーダル」戻り時にも返せるようにする。
        // index は handleIndexChange で随時保存されているのでここでは触らず、
        // 現在保存されている値をそのまま使う。
        try {
          const savedIdx = sessionStorage.getItem(FEED_INDEX_KEY);
          const savedSig = sessionStorage.getItem(FEED_FILTER_KEY) ?? "";
          // seed がないケース (playlist 経由で初期取得をスキップしたとき) もセッションに
          // 存在しないとダメなので、-1 でダミーとして保存しておく。
          saveSession(
            seed ?? -1,
            savedIdx ? parseInt(savedIdx, 10) : 0,
            merged,
            nextCursorRef.current,
            savedSig,
          );
        } catch { /* ignore */ }
        return merged;
      });
    } catch (e) {
      console.error("fetchMore failed", e);
    } finally {
      isFetchingMoreRef.current = false;
    }
  }, []);

  // FeedViewer から "残りわずか" になったときに呼ばれる。ただし同一位置で連発しないように
  // useCallback でラップして、中で fetchMore を一回だけ走らせる。
  const handleNearEnd = useCallback(() => {
    void fetchMore();
  }, [fetchMore]);

  const handleIndexChange = useCallback((index: number) => {
    const cur = items[index];
    if (cur) {
      markSeen(cur.id);
      // ランキング集計のために view イベントを記録 (サーバ側で集計、認証不要)
      logEvent({ event_type: "view", slug: cur.slug, title: cur.title });
      // ログイン中のみ視聴履歴に記録 (未ログインだと 401 になるのでスキップ)
      if (authStatus === "authenticated") {
        void recordView(cur.id);
      }
    }
    try { sessionStorage.setItem(FEED_INDEX_KEY, String(index)); } catch { /* ignore */ }
  }, [items, authStatus]);

  const firstViewLoggedRef = useRef(false);
  useEffect(() => {
    if (isLoading) return;
    if (firstViewLoggedRef.current) return;
    const cur = items[initialIndex];
    if (!cur) return;
    firstViewLoggedRef.current = true;
    markSeen(cur.id);
    logEvent({ event_type: "view", slug: cur.slug, title: cur.title });
    if (authStatus === "authenticated") {
      void recordView(cur.id);
    }
  }, [isLoading, items, initialIndex, authStatus]);

  if (isEmpty) {
    return (
      <div className="feed-empty">
        <p className="feed-empty-text">条件に合う動画が見つかりません</p>
      </div>
    );
  }

  if (isLoading || items.length === 0) {
    return (
      <div className="feed-loading">
        <div className="feed-spinner" />
      </div>
    );
  }

  return (
    <>
      <FeedViewer
        items={items}
        initialIndex={initialIndex}
        onIndexChange={handleIndexChange}
        onNearEnd={handleNearEnd}
      />
      <style>{uiStyle}</style>
    </>
  );
}

const uiStyle = `
  .feed-loading {
    position: fixed; inset: 0;
    display: flex; align-items: center; justify-content: center;
    background: #000;
  }
  .feed-spinner {
    width: 40px; height: 40px;
    border: 3px solid rgba(255,255,255,0.15);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .feed-empty {
    position: fixed; inset: 0;
    display: flex; align-items: center; justify-content: center;
    background: #000;
  }
  .feed-empty-text {
    font-size: 15px;
    color: rgba(255,255,255,0.5);
  }
`;
