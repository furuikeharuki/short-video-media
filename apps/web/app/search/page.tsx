import Link from "next/link";
import { searchMovies } from "@/lib/api/search";

type Props = { searchParams: Promise<{ q?: string }> };

export default async function SearchPage({ searchParams }: Props) {
  const { q } = await searchParams;
  const query = q?.trim() ?? "";

  if (!query) {
    return (
      <main style={styles.main}>
        <p style={styles.empty}>検索ワードを入力してください</p>
        <style>{pageCSS}</style>
      </main>
    );
  }

  let items: Awaited<ReturnType<typeof searchMovies>>["items"] = [];
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
        <div style={styles.grid}>
          {items.map((item, index) => (
            <Link
              key={item.id}
              href={`/search/feed?q=${encodeURIComponent(query)}&start=${index}`}
              style={styles.card}
            >
              <div style={styles.thumbWrap}>
                <img
                  src={item.thumbnail_url}
                  alt={item.title}
                  style={styles.thumb}
                  loading={index < 6 ? "eager" : "lazy"}
                  width={360}
                  height={640}
                />
                {item.sample_video_url && (
                  <span style={styles.playBadge}>▶</span>
                )}
              </div>
              <p style={styles.cardTitle}>{item.title}</p>
            </Link>
          ))}
        </div>
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
  // grid は CSS で制御（メディアクエリのため）
  grid: {},
  card: {
    display: "block",
    textDecoration: "none",
    color: "#fff",
    position: "relative" as const,
  },
  thumbWrap: {
    position: "relative" as const,
    width: "100%",
    paddingBottom: "177.77%",
    background: "#111",
    overflow: "hidden",
  },
  thumb: {
    position: "absolute" as const,
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover" as const,
    display: "block",
    transition: "transform 0.2s ease",
  },
  playBadge: {
    position: "absolute" as const,
    bottom: "6px",
    left: "6px",
    fontSize: "12px",
    color: "rgba(255,255,255,0.8)",
    textShadow: "0 1px 4px rgba(0,0,0,0.8)",
  },
  cardTitle: {
    fontSize: "11px",
    lineHeight: 1.3,
    padding: "4px 4px 8px",
    color: "rgba(255,255,255,0.75)",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical" as const,
    overflow: "hidden",
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

  /* スマホ: 3カラム */
  .search-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 2px;
    padding: 2px;
  }
  /* タブレット: 5カラム */
  @media (min-width: 640px) {
    .search-grid { grid-template-columns: repeat(5, 1fr); }
  }
  /* PC: 7カラム、最大幅で中央寄せ */
  @media (min-width: 1024px) {
    .search-grid {
      grid-template-columns: repeat(7, 1fr);
      max-width: 1200px;
      margin: 0 auto;
    }
  }
  .search-card img:hover { transform: scale(1.04); }
`;
