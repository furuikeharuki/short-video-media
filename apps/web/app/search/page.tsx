import SearchInfiniteGrid from "./SearchInfiniteGrid";
import SearchResultsHeader from "@/components/SearchResultsHeader";
import type { AdvancedSearchInput, SortKey } from "@/lib/api/search";

type Props = {
  searchParams: Promise<{
    q?: string;
    genre?: string;
    director?: string;
    maker?: string;
    label?: string;
    series?: string;
    // 詳細検索パラメータ (複数指定可なので string | string[])
    genres?: string | string[];
    actresses?: string | string[];
    series_list?: string | string[];
    directors?: string | string[];
    makers?: string | string[];
    labels?: string | string[];
    ng_words?: string | string[];
    date_from?: string;
    date_to?: string;
    sort?: string;
  }>;
};

/**
 * 検索結果ページ。
 *
 * - キーワード (q): タイトル / 説明 / 女優 / ジャンル / 監督 / メーカー / レーベル / シリーズの部分一致
 * - genre: ジャンル絞り込み (ホームの「もっと見る」と同等の動作)
 * - director / maker / label / series: 各メタデータの完全一致
 * - 詳細検索: genres / actresses / series_list / directors / makers / labels / date_from / date_to / sort / ng_words
 *
 * 修正5 以降は画面上部に `SearchResultsHeader` (戻る + ラベル + フィルター)
 * を常時表示し、詳細検索パネル開閉と適用条件の自動保存をここから行う。
 */
export default async function SearchPage({ searchParams }: Props) {
  const sp = await searchParams;
  const query = sp.q?.trim() ?? "";
  const genreTag = sp.genre?.trim() ?? "";
  const directorName = sp.director?.trim() ?? "";
  const makerName = sp.maker?.trim() ?? "";
  const labelName = sp.label?.trim() ?? "";
  const seriesName = sp.series?.trim() ?? "";

  // 詳細検索の複数値パラメータ。URL に `?genres=A&genres=B` で来た場合は配列、
  // `?genres=A` 単独の場合は文字列なのでどちらも配列に正規化する。
  const toArr = (v: string | string[] | undefined): string[] => {
    if (!v) return [];
    const arr = Array.isArray(v) ? v : [v];
    return arr.map((s) => s.trim()).filter(Boolean);
  };
  const genres = toArr(sp.genres);
  const actresses = toArr(sp.actresses);
  const seriesList = toArr(sp.series_list);
  const directors = toArr(sp.directors);
  const makers = toArr(sp.makers);
  const labels = toArr(sp.labels);
  const ngWords = toArr(sp.ng_words);
  const dateFrom = sp.date_from?.trim() ?? "";
  const dateTo = sp.date_to?.trim() ?? "";
  const validSort = new Set<SortKey>([
    "new",
    "popular",
    "rating",
    "views",
    "bookmarks",
  ]);
  const sort: SortKey | undefined =
    sp.sort && validSort.has(sp.sort as SortKey)
      ? (sp.sort as SortKey)
      : undefined;

  // 「詳細検索っぽい条件」が 1 つでも乗っていたら advanced 経路に分岐する。
  // q だけしか無い場合や、director/maker/label/series/genre 単独はこれまで通り
  // 既存の検索パスを維持する。
  const hasAdvancedFilter =
    genres.length > 0 ||
    actresses.length > 0 ||
    seriesList.length > 0 ||
    directors.length > 0 ||
    makers.length > 0 ||
    labels.length > 0 ||
    ngWords.length > 0 ||
    !!dateFrom ||
    !!dateTo ||
    !!sort;

  if (hasAdvancedFilter) {
    const input: AdvancedSearchInput = {
      q: query || undefined,
      genres: genres.length > 0 ? genres : undefined,
      actresses: actresses.length > 0 ? actresses : undefined,
      series_list: seriesList.length > 0 ? seriesList : undefined,
      directors: directors.length > 0 ? directors : undefined,
      makers: makers.length > 0 ? makers : undefined,
      labels: labels.length > 0 ? labels : undefined,
      ng_words: ngWords.length > 0 ? ngWords : undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      sort,
    };
    // サブヘッダーラベル: 主要な条件を上から拾って 1 個だけ採用する。
    let headerLabel = "詳細検索";
    if (query) headerLabel = `「${query}」`;
    else if (genres.length) headerLabel = `#${genres[0]}`;
    else if (actresses.length) headerLabel = actresses.join(", ");
    else if (seriesList.length) headerLabel = `シリーズ: ${seriesList[0]}`;
    else if (directors.length) headerLabel = `監督: ${directors[0]}`;
    else if (makers.length) headerLabel = `メーカー: ${makers[0]}`;
    else if (labels.length) headerLabel = `レーベル: ${labels[0]}`;
    // playlistKey は input から導出 (string 化で安定するキーを作る)
    const playlistKey = `search-adv-${JSON.stringify({
      q: input.q,
      g: input.genres,
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
      <SearchInfiniteGrid
        source={{ kind: "advanced", input }}
        playlistKey={playlistKey}
        playlistTitle="詳細検索"
        headingPrefix={headerLabel}
        headerSlot={<SearchResultsHeader label={headerLabel} keyword={query} />}
      />
    );
  }

  // 監督 / メーカー / レーベル / シリーズ の完全一致検索
  if (directorName || makerName || labelName || seriesName) {
    let field: "director" | "maker" | "label" | "series";
    let value: string;
    let prefix: string;
    if (directorName) { field = "director"; value = directorName; prefix = "監督"; }
    else if (makerName) { field = "maker"; value = makerName; prefix = "メーカー"; }
    else if (labelName) { field = "label"; value = labelName; prefix = "レーベル"; }
    else { field = "series"; value = seriesName; prefix = "シリーズ"; }

    const headerLabel = `${prefix}「${value}」`;
    return (
      <SearchInfiniteGrid
        source={{ kind: "exact", field, value }}
        playlistKey={`search-${field}-${value}`}
        playlistTitle={`${prefix}「${value}」`}
        headingPrefix={`${prefix}「${value}」の作品`}
        headerSlot={<SearchResultsHeader label={headerLabel} keyword="" />}
      />
    );
  }

  if (genreTag) {
    const headerLabel = `#${genreTag}`;
    return (
      <SearchInfiniteGrid
        source={{ kind: "genre", genre: genreTag }}
        playlistKey={`search-genre-${genreTag}`}
        playlistTitle={`#${genreTag}`}
        headingPrefix={`#${genreTag} の動画`}
        headerSlot={<SearchResultsHeader label={headerLabel} keyword="" />}
      />
    );
  }

  if (!query) {
    return (
      <main style={styles.main}>
        <SearchResultsHeader label="検索" keyword="" />
        <p style={styles.empty}>検索ワードを入力してください</p>
        <style>{pageCSS}</style>
      </main>
    );
  }

  const headerLabel = `「${query}」`;
  return (
    <SearchInfiniteGrid
      source={{ kind: "keyword", query }}
      playlistKey={`search-q-${query}`}
      playlistTitle={`「${query}」の検索結果`}
      headingPrefix={`"${query}" の検索結果`}
      headerSlot={<SearchResultsHeader label={headerLabel} keyword={query} />}
    />
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    position: "fixed" as const,
    top: "52px",
    left: 0,
    right: 0,
    bottom: "var(--bottom-nav-h, 56px)" as unknown as string,
    overflowY: "auto" as const,
    background: "#0a0a0a",
    color: "#fff",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  empty: {
    textAlign: "center" as const,
    color: "rgba(255,255,255,0.4)",
    fontSize: "14px",
    marginTop: "80px",
  },
};

const pageCSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #0a0a0a !important; overflow: hidden !important; }
`;
