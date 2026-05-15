import { searchMovies } from "@/lib/api/search";
import { getFeed } from "@/lib/api/feed";
import type { MovieCard } from "@/lib/api/feed";
import SearchGrid from "./SearchGrid";

type Props = { searchParams: Promise<{ q?: string; genre?: string }> };

export default async function SearchPage({ searchParams }: Props) {
  const { q, genre } = await searchParams;
  const query  = q?.trim() ?? "";
  const genreTag = genre?.trim() ?? "";

  // タグ指定時: ジャンルフィルターでフィードを取得
  if (genreTag) {
    let items: MovieCard[] = [];
    try {
      const res = await getFeed(0, 40, 0, [genreTag]);
      items = res.items;
    } catch {
      // エラー時は空配列
    }
    return (
      <main style={styles.main}>
        <p style={styles.meta}>
          #{genreTag} の動画：{items.length}件
        </p>
        {items.length === 0 ? (
          <p style={styles.empty}>該当する作品が見つかりませんでした</p>
        ) : (
          <SearchGrid items={items} />
        )}
        <style>{pageCSS}</style>
      </main>
    );
  }

  // テキスト検索
  if (!query) {
    return (
      <main style={styles.main}>
        <p style={styles.empty}>検索ワードを入力してください</p>
        <style>{pageCSS}</style>
      </main>
    );
  }

  let items: MovieCard[] = [];
  try {
    const result = await searchMovies(query);
    items = result.items;
  } catch {
    // エラー時は空配列のまま続行
  }

  return (
    <main style={styles.main}>
      <p style={styles.meta}>
        &ldquo;{query}&rdquo; の検索結果：{items.length}件
      </p>
      {items.length === 0 ? (
        <p style={styles.empty}>該当する作品が見つかりませんでした</p>
      ) : (
        <SearchGrid items={items} />
      )}
      <style>{pageCSS}</style>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    position: "fixed" as const,
    top: "52px",
    left: 0,
    right: 0,
    bottom: 0,
    overflowY: "auto" as const,
    background: "#0a0a0a",
    color: "#fff",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  meta: {
    fontSize: "12px",
    color: "rgba(255,255,255,0.45)",
    padding: "12px 16px 4px",
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
  .search-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 2px;
    padding: 2px;
  }
  @media (min-width: 640px) {
    .search-grid { grid-template-columns: repeat(5, 1fr); }
  }
  @media (min-width: 1024px) {
    .search-grid {
      grid-template-columns: repeat(7, 1fr);
      max-width: 1200px;
      margin: 0 auto;
    }
  }
  .search-grid a:hover img { transform: scale(1.04); }
`;
