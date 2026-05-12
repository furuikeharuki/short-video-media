import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import AffiliateLink from "@/components/analytics/affiliate-link";
import DetailViewTracker from "@/components/analytics/detail-view-tracker";
import { getMovieBySlug } from "@/lib/api/movies";

type PageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  try {
    const { slug } = await params;
    const movie = await getMovieBySlug(slug);
    return { title: `${movie.title} | Short Video Media` };
  } catch {
    return { title: "Short Video Media" };
  }
}

export default async function MovieDetailPage({ params }: PageProps) {
  const { slug } = await params;

  try {
    const movie = await getMovieBySlug(slug);

    return (
      <>
        <main style={styles.main}>
          <DetailViewTracker slug={movie.slug} title={movie.title} />

          {/* サムネイルヘッダー */}
          <div style={styles.heroWrap}>
            <img
              src={movie.thumbnail_url}
              alt={movie.title}
              style={styles.heroImg}
              width={720}
              height={1280}
              loading="eager"
            />
            <div style={styles.heroOverlay} />
            <Link href="/" style={styles.backBtn} aria-label="フィードに戻る">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 5l-7 7 7 7" />
              </svg>
            </Link>
          </div>

          {/* コンテンツエリア */}
          <div style={styles.content}>
            {/* ジャンルバッジ */}
            <div style={styles.genreList}>
              {movie.genres.map((g) => (
                <span key={g} style={styles.badge}>{g}</span>
              ))}
            </div>

            <h1 style={styles.title}>{movie.title}</h1>

            {movie.actresses.length > 0 && (
              <p style={styles.actress}>👤 {movie.actresses.join(" / ")}</p>
            )}

            {/* 説明 */}
            {movie.description && (
              <p style={styles.description}>{movie.description}</p>
            )}

            {/* CTAボタン */}
            <div style={styles.ctaArea}>
              <AffiliateLink
                href={movie.affiliate_url}
                slug={movie.slug}
                title={movie.title}
              />
            </div>
          </div>
        </main>

        <style>{pageCSS}</style>
      </>
    );
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") {
      notFound();
    }
    throw error;
  }
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: '100dvh',
    background: '#0a0a0a',
    color: '#fff',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  heroWrap: {
    position: 'relative',
    width: '100%',
    aspectRatio: '3 / 4',
    maxHeight: '70dvh',
    overflow: 'hidden',
    background: '#111',
  },
  heroImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  heroOverlay: {
    position: 'absolute',
    inset: 0,
    background: 'linear-gradient(to bottom, rgba(0,0,0,0.35) 0%, transparent 40%, rgba(10,10,10,0.9) 100%)',
  },
  backBtn: {
    position: 'absolute',
    top: '16px',
    left: '16px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    background: 'rgba(0,0,0,0.5)',
    backdropFilter: 'blur(8px)',
    color: '#fff',
    textDecoration: 'none',
    border: '1px solid rgba(255,255,255,0.15)',
  },
  content: {
    padding: '24px 20px 48px',
    maxWidth: '640px',
    margin: '0 auto',
  },
  genreList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    marginBottom: '14px',
  },
  badge: {
    display: 'inline-block',
    background: 'rgba(255,255,255,0.1)',
    border: '1px solid rgba(255,255,255,0.2)',
    color: 'rgba(255,255,255,0.7)',
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.05em',
    padding: '3px 10px',
    borderRadius: '999px',
  },
  title: {
    fontSize: 'clamp(20px, 5vw, 28px)' as unknown as string,
    fontWeight: 700,
    lineHeight: 1.3,
    marginBottom: '10px',
    color: '#fff',
  },
  actress: {
    fontSize: '14px',
    color: 'rgba(255,255,255,0.55)',
    marginBottom: '16px',
  },
  description: {
    fontSize: '14px',
    lineHeight: 1.8,
    color: 'rgba(255,255,255,0.6)',
    marginBottom: '28px',
    borderTop: '1px solid rgba(255,255,255,0.08)',
    paddingTop: '20px',
  },
  ctaArea: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
  },
};

const pageCSS = `
  .affiliate-btn {
    display: block;
    width: 100%;
    padding: 16px;
    background: #e91e63;
    color: #fff;
    font-size: 16px;
    font-weight: 700;
    border-radius: 12px;
    text-align: center;
    text-decoration: none;
    min-height: 52px;
    line-height: 1.2;
    transition: opacity 0.15s ease, transform 0.15s ease;
  }
  .affiliate-btn:active {
    opacity: 0.75;
    transform: scale(0.98);
  }
  @media (hover: hover) {
    .affiliate-btn:hover { opacity: 0.88; }
  }
`;
