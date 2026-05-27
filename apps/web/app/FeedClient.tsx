"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import FeedSurface from "@/components/feed/FeedSurface";
import { getOrCreateSeed } from "@/lib/feedOrder";
import { getFeed, type FeedAdvancedParams } from "@/lib/api/feed";
import { getHomeSection, type HomeSectionKey } from "@/lib/api/homeSection";
import { getMovieBySlug } from "@/lib/api/movies";
import { loadPlaylist, clearPlaylist, type PlaylistSource } from "@/lib/feedPlaylist";
import { useSavedFilterStatus } from "@/components/SavedFilterContext";
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
    sort: (sp.get("sort") ?? "").trim() || undefined,
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
    !!advanced.date_to ||
    !!advanced.sort;
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
    s: advanced.sort ?? "",
  };
  return JSON.stringify(norm);
}

export default function FeedClient() {
  const searchParams  = useSearchParams();
  // SavedFilterEnforcer が URL に保存済みフィルターを注入し終わるまで "pending"。
  // pending の間は 古い / フィルター未適用の feed を一瞬でも描画させず、
  // 読み込みスピナーを持続表示する。
  const enforceStatus = useSavedFilterStatus();
  const seedRef       = useRef<number | null>(null);
  const isFetchingRef = useRef(false);
  const isFetchingMoreRef = useRef(false);
  const nextCursorRef = useRef<string | null>(null);
  // playlist 経由で起動したときは /api/v1/home/section で継足しするため、
  // その出所情報 (セクション key / ジャンル名) を保持する。
  const playlistSourceRef = useRef<PlaylistSource | null>(null);
  // 「この /feed セッションは playlist 経由で起動された」フラグ。
  // ブックマーク / 視聴履歴 / ホーム各セクション / 女優詳細 / 検索結果カードからの
  // 起動は「そのリストの順をそのまま見せる」のが意図なので、フィルターを効かせず
  // playlist の中身をそのまま表示、継足しも (source があれば) 同じセクション から取る。
  const cameFromPlaylistRef = useRef<boolean>(false);
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
    // /feed 上で MovieDetailModal を開くと window.history.pushState で URL バーが
    // /movies/<slug> に書き換わる。Next.js 15 ではこの pushState を router が検知し、
    // useSearchParams() が空文字列を返すようになるため、ここでの currentSig が変わって
    // しまい意図せず再フェッチが走り「別の feed が始まる」ように見えてしまう。
    // モーダル open/close で URL バーが一時的に /movies/ 系に切り替わっている間は
    // フィードの再ロードを抑止する。
    //
    // 重要: filtersRef.current の更新も /feed 上にいるときだけにする。
    // モーダル open で pushState されると useSearchParams が空を返し、
    // currentGenres / currentAdvanced も空になる。ここで filtersRef を上書きしてしまうと、
    // モーダル open 中にユーザーがスワイプして FeedViewer の onNearEnd が発火 → fetchMore →
    // 「フィルターなし」でページ追加 fetch されてしまい、モーダルを閉じた後の /feed に
    // フィルター違反作品が混ざる (= 「フィルターの設定がなくなったように見える」) ことに
    // なる。pathname が /feed のときだけ ref を最新化し、それ以外では現状値を保つ。
    if (
      typeof window !== "undefined" &&
      !window.location.pathname.startsWith("/feed")
    ) {
      return;
    }

    // フィルター ref を最新に更新 (fetchMore から参照される)
    filtersRef.current = { genres: currentGenres, advanced: currentAdvanced };

    // SavedFilterEnforcer がまだ saved pref を読んで URL を確定させていない間は
    // fetch しない。ここで走らせてしまうと、例えばフィルター設定済みで
    // 「他ページ -> /feed (URL にフィルター無し)」と戻ったときに、
    // フィルター未適用のフィードを 1 回取りにいってしまい "違反作品が一瞬見える" ことになる。
    // ready になった時点では currentSig が最新の URL を反映するので、
    // そのタイミングで初期 fetch を走らせる。
    if (enforceStatus === "pending") {
      setIsLoading(true);
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
        // playlist 経由フラグを立てる。これにより fetchMore でも「フィルターを適用しない」を貫く。
        cameFromPlaylistRef.current = true;
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
      cameFromPlaylistRef.current = false;
    } else {
      // playlist 経由でないとき (通常 /feed) はフラグを起こさない。
      cameFromPlaylistRef.current = false;
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
  // currentSig / enforceStatus が変わったらフィルター適用扱いで再フェッチさせる。
  // pending -> ready に遷移したところでも 1 回トリガーさせて初期 fetch を走らせる。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSig, enforceStatus]);

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
    // ただし、フィルター (女優 / NG 語 / etc) が適用されているときは
    // home/section API はフィルターを受け付けないため、そのままの順で
    // 追加ロードするとフィルター違反作品が混ざってしまう。
    // フィルターがある場合は playlist 順を諦めて "/feed" 通常フェッチ
    // (フィルター適用済み) にフォールバックして、スクロールした先も
    // 必ずフィルターに適合させる。
    const source = playlistSourceRef.current;
    const seed = seedRef.current;
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
      !!advanced.date_to ||
      !!advanced.sort;
    isFetchingMoreRef.current = true;
    try {
      let resItems: MovieCard[];
      let resCursor: string | null;

      // playlist 経由 (ブックマーク / 視聴履歴 / ホームセクション / 女優 / 検索結果 他) は
      // 「そのリストをそのまま見せる」のが意図なので、ここではフィルターを一切適用しない。
      //  - source あり (セクション起源) → /api/v1/home/section で同じ順に継足し
      //  - source 無し (search-* など セクション離れた playlist) → 継足ししない (末尾で打ち止め)
      // playlist 経由でない (通常の /feed) ときだけフィルターを AND 適用する。
      if (cameFromPlaylistRef.current) {
        if (!source) {
          // 継足し不可 → ここで打ち止め
          nextCursorRef.current = null;
          return;
        }
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

  if (isEmpty) {
    return (
      <div className="feed-empty">
        <p className="feed-empty-text">条件に合う動画が見つかりません</p>
      </div>
    );
  }

  // pending 中はスピナーのみ見せ、フィルター未適用の feed を描画しない。
  if (enforceStatus === "pending" || isLoading || items.length === 0) {
    return (
      <div className="feed-loading">
        <div className="feed-spinner" />
      </div>
    );
  }

  return (
    <>
      <FeedSurface
        items={items}
        initialIndex={initialIndex}
        ready={!isLoading}
        sessionIndexKey={FEED_INDEX_KEY}
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
