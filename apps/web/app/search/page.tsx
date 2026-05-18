import SearchInfiniteGrid from "./SearchInfiniteGrid";
import SearchResultsHeader, {
  type SearchHeaderContext,
} from "@/components/SearchResultsHeader";
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
    // 文脈クエリ (genre / director / maker / label / series の単一キー) を advanced 入力に統合して
    // 「掛け合わせ検索」にする。例えば `/search?genre=巫乳&actresses=...` は
    // 'genre=巫乳' を "AND" に保ちつつ actresses も絞り込む。
    const mergedGenres = (() => {
      if (!genreTag) return genres;
      const set = new Set<string>([genreTag, ...genres]);
      return Array.from(set);
    })();
    const mergedDirectors = (() => {
      if (!directorName) return directors;
      const set = new Set<string>([directorName, ...directors]);
      return Array.from(set);
    })();
    const mergedMakers = (() => {
      if (!makerName) return makers;
      const set = new Set<string>([makerName, ...makers]);
      return Array.from(set);
    })();
    const mergedLabels = (() => {
      if (!labelName) return labels;
      const set = new Set<string>([labelName, ...labels]);
      return Array.from(set);
    })();
    const mergedSeries = (() => {
      if (!seriesName) return seriesList;
      const set = new Set<string>([seriesName, ...seriesList]);
      return Array.from(set);
    })();

    const input: AdvancedSearchInput = {
      q: query || undefined,
      genres: mergedGenres.length > 0 ? mergedGenres : undefined,
      actresses: actresses.length > 0 ? actresses : undefined,
      series_list: mergedSeries.length > 0 ? mergedSeries : undefined,
      directors: mergedDirectors.length > 0 ? mergedDirectors : undefined,
      makers: mergedMakers.length > 0 ? mergedMakers : undefined,
      labels: mergedLabels.length > 0 ? mergedLabels : undefined,
      ng_words: ngWords.length > 0 ? ngWords : undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      sort,
    };
    // サブヘッダーラベル / context: 文脈クエリ (q/genre/exact) があればそれを優先し、
    // それを失わずフィルター適用・クリアでも保持されるようにする。
    let headerLabel: string;
    let headerContext: SearchHeaderContext;
    if (query) {
      headerLabel = `「${query}」`;
      headerContext = { kind: "keyword", q: query };
    } else if (genreTag) {
      headerLabel = `#${genreTag}`;
      headerContext = { kind: "genre", genre: genreTag };
    } else if (directorName) {
      headerLabel = `監督「${directorName}」`;
      headerContext = { kind: "exact", field: "director", value: directorName };
    } else if (makerName) {
      headerLabel = `メーカー「${makerName}」`;
      headerContext = { kind: "exact", field: "maker", value: makerName };
    } else if (labelName) {
      headerLabel = `レーベル「${labelName}」`;
      headerContext = { kind: "exact", field: "label", value: labelName };
    } else if (seriesName) {
      headerLabel = `シリーズ「${seriesName}」`;
      headerContext = { kind: "exact", field: "series", value: seriesName };
    } else {
      // 文脈が一つも無い → 純粋な「詳細検索」ケース (詳細検索のチップだけで進んだ状態)。
      // ラベルは「詳細検索」と代表適用チップ 1 つをコンパクトに表示。
      let tip = "詳細検索";
      if (mergedGenres.length) tip = `#${mergedGenres[0]}`;
      else if (actresses.length) tip = actresses[0];
      else if (mergedSeries.length) tip = `シリーズ: ${mergedSeries[0]}`;
      else if (mergedDirectors.length) tip = `監督: ${mergedDirectors[0]}`;
      else if (mergedMakers.length) tip = `メーカー: ${mergedMakers[0]}`;
      else if (mergedLabels.length) tip = `レーベル: ${mergedLabels[0]}`;
      headerLabel = tip;
      headerContext = { kind: "advanced", q: "" };
    }
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
        playlistTitle={headerLabel}
        headingPrefix={headerLabel}
        headerSlot={<SearchResultsHeader label={headerLabel} context={headerContext} />}
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
        headerSlot={<SearchResultsHeader label={headerLabel} context={{ kind: "exact", field, value }} />}
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
        headerSlot={<SearchResultsHeader label={headerLabel} context={{ kind: "genre", genre: genreTag }} />}
      />
    );
  }

  if (!query) {
    return (
      <main style={styles.main}>
        <SearchResultsHeader label="検索" context={{ kind: "keyword", q: "" }} />
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
      headerSlot={<SearchResultsHeader label={headerLabel} context={{ kind: "keyword", q: query }} />}
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
