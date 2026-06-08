import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import AdSlot from "@/components/ads/AdSlot";
import SimpleBackButton from "@/components/SimpleBackButton";
import MovieCardThumb from "@/components/home/MovieCardThumb";
import { getGenreMovies } from "@/lib/api/genres";
import { SITE_NAME, SITE_URL, SITE_LOCALE } from "@/lib/config/seo";

// ISR: ジャンル集約ページは 1 時間キャッシュ。
export const revalidate = 3600;

// 初期表示件数。コンテンツ量を充実させ、競合ページとの差を縮めるため 60 件に増加。
const INITIAL_LIMIT = 60;

type PageProps = {
  params: Promise<{ genre: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { genre } = await params;
  const decoded = decodeURIComponent(genre);
  const canonical = `${SITE_URL}/genres/${encodeURIComponent(decoded)}`;

  let total = 0;
  try {
    const data = await getGenreMovies(decoded, INITIAL_LIMIT);
    total = data.total;
  } catch {
    // メタデータ取得失敗時もページ自体は描画を試みる。
  }

  const title = `${decoded} のAVショート動画一覧 | ${SITE_NAME}`;
  const description =
    total > 0
      ? `ジャンル「${decoded}」のAVショート動画 ${total}件。新作順で試し見でき、気に入った作品はFANZAでそのまま購入できます。`
      : `ジャンル「${decoded}」のAVショート動画一覧。`;

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      type: "website",
      url: canonical,
      title,
      description,
      siteName: SITE_NAME,
      locale: SITE_LOCALE,
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}

export default async function GenrePage({ params }: PageProps) {
  const { genre } = await params;
  const decoded = decodeURIComponent(genre);

  let result;
  try {
    result = await getGenreMovies(decoded, INITIAL_LIMIT);
  } catch {
    notFound();
  }

  const { items, total } = result;

  if (items.length === 0) {
    notFound();
  }

  const canonical = `${SITE_URL}/genres/${encodeURIComponent(decoded)}`;

  const collectionJsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${decoded} のAVショート動画一覧`,
    url: canonical,
    isPartOf: { "@type": "WebSite", name: SITE_NAME, url: SITE_URL },
    about: { "@type": "Thing", name: decoded },
  };

  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `${decoded} の作品リスト`,
    numberOfItems: items.length,
    itemListElement: items.map((m, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `${SITE_URL}/movies/${encodeURIComponent(m.slug)}`,
      name: m.title,
    })),
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "ホーム", item: SITE_URL },
      { "@type": "ListItem", position: 2, name: decoded, item: canonical },
    ],
  };

  return (
    <main style={styles.main}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />

      <div style={styles.topBar}>
        <div style={styles.backWrap}>
          <SimpleBackButton fallbackHref="/" />
        </div>
      </div>

      <div style={styles.body}>
        <header style={styles.header}>
          <h1 style={styles.title}>#{decoded}</h1>
          <p style={styles.desc}>ジャンル「{decoded}」のAVショート動画</p>
        </header>

        <div className="genre-grid">
          {items.map((m, i) => (
            <MovieCardThumb
              key={m.id}
              movie={m}
              aspect="portrait"
              fluid
              playlist={{
                key: `genre-${decoded}`,
                title: `#${decoded}`,
                startIndex: i,
                items,
                source: { kind: "section", key: "genre", genre: decoded },
              }}
            />
          ))}
        </div>

        {total > items.length && (
          <div style={styles.moreWrap}>
            {/*
             * robots.txt の /search Disallow を削除したため、内部リンクとして復元。
             * /search は noindex,follow なのでインデックスはされず、
             * クローラーはリンクをたどれる。ユーザーはサイト内に留まる。
             */}
            <Link
              href={`/search?genre=${encodeURIComponent(decoded)}`}
              style={styles.moreLink}
            >
              {decoded} の動画をもっと見る
            </Link>
          </div>
        )}

        <div style={styles.adBottom}>
          <AdSlot zone="mobileBanner300x250" />
        </div>
      </div>
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
    overflowX: "hidden" as const,
    background: "#0a0a0a",
    color: "#fff",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  topBar: {
    position: "relative" as const,
    width: "100%",
    height: "56px",
    flexShrink: 0,
    display: "flex",
    alignItems: "center" as const,
  },
  backWrap: {
    display: "flex",
    alignItems: "center" as const,
    paddingLeft: "12px",
  },
  body: {
    padding: "4px 16px 80px",
    overflowX: "hidden" as const,
    boxSizing: "border-box" as const,
    width: "100%",
  },
  header: {
    marginBottom: "16px",
  },
  title: {
    fontSize: "clamp(20px, 5.5vw, 26px)",
    fontWeight: 700,
    lineHeight: 1.3,
    color: "#fff",
    margin: 0,
  },
  desc: {
    fontSize: "13px",
    color: "rgba(255,255,255,0.55)",
    lineHeight: 1.6,
    marginTop: "8px",
  },
  moreWrap: {
    marginTop: "20px",
    display: "flex",
    justifyContent: "center" as const,
  },
  moreLink: {
    display: "inline-block",
    padding: "10px 20px",
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.2)",
    color: "rgba(255,255,255,0.85)",
    fontSize: "13px",
    fontWeight: 600,
    borderRadius: "999px",
    textDecoration: "none",
  },
  adBottom: {
    marginTop: "24px",
    marginBottom: "8px",
    width: "100%",
    display: "flex",
    justifyContent: "center" as const,
  },
};

const pageCSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #0a0a0a !important; }

  .genre-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }
  @media (min-width: 640px) {
    .genre-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }
  @media (min-width: 1024px) {
    .genre-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  }
`;
