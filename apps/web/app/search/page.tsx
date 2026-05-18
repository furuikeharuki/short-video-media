import SearchInfiniteGrid from "./SearchInfiniteGrid";

type Props = {
  searchParams: Promise<{
    q?: string;
    genre?: string;
    director?: string;
    maker?: string;
    label?: string;
    series?: string;
  }>;
};

/**
 * 検索結果ページ。
 *
 * - キーワード (q): タイトル / 説明 / 女優 / ジャンル / 監督 / メーカー / レーベル / シリーズの部分一致
 * - genre: ジャンル絞り込み (ホームの「もっと見る」と同等の動作)
 * - director / maker / label / series: 各メタデータの完全一致
 *
 * いずれの条件でも `SearchInfiniteGrid` がクライアント側で 20件前後ずつ
 * ページング読み込みする (IntersectionObserver で無限スクロール)。
 */
export default async function SearchPage({ searchParams }: Props) {
  const { q, genre, director, maker, label, series } = await searchParams;
  const query = q?.trim() ?? "";
  const genreTag = genre?.trim() ?? "";
  const directorName = director?.trim() ?? "";
  const makerName = maker?.trim() ?? "";
  const labelName = label?.trim() ?? "";
  const seriesName = series?.trim() ?? "";

  // 監督 / メーカー / レーベル / シリーズ の完全一致検索
  if (directorName || makerName || labelName || seriesName) {
    let field: "director" | "maker" | "label" | "series";
    let value: string;
    let prefix: string;
    if (directorName) { field = "director"; value = directorName; prefix = "監督"; }
    else if (makerName) { field = "maker"; value = makerName; prefix = "メーカー"; }
    else if (labelName) { field = "label"; value = labelName; prefix = "レーベル"; }
    else { field = "series"; value = seriesName; prefix = "シリーズ"; }

    return (
      <SearchInfiniteGrid
        source={{ kind: "exact", field, value }}
        playlistKey={`search-${field}-${value}`}
        playlistTitle={`${prefix}「${value}」`}
        headingPrefix={`${prefix}「${value}」の作品`}
      />
    );
  }

  if (genreTag) {
    return (
      <SearchInfiniteGrid
        source={{ kind: "genre", genre: genreTag }}
        playlistKey={`search-genre-${genreTag}`}
        playlistTitle={`#${genreTag}`}
        headingPrefix={`#${genreTag} の動画`}
      />
    );
  }

  if (!query) {
    return (
      <main style={styles.main}>
        <p style={styles.empty}>検索ワードを入力してください</p>
        <style>{pageCSS}</style>
      </main>
    );
  }

  return (
    <SearchInfiniteGrid
      source={{ kind: "keyword", query }}
      playlistKey={`search-q-${query}`}
      playlistTitle={`「${query}」の検索結果`}
      headingPrefix={`"${query}" の検索結果`}
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
