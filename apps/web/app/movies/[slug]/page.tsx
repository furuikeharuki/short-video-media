import { notFound } from "next/navigation";
import type { Metadata } from "next";

import AffiliateLink from "@/components/analytics/affiliate-link";
import DetailViewTracker from "@/components/analytics/detail-view-tracker";
import BackButton from "@/components/BackButton";
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

          <div style={styles.heroWrap}>
            <img src={movie.thumbnail_url} alt="" aria-hidden="true" style={styles.heroBgBlur} />
            <img
              src={movie.thumbnail_url}
              alt={movie.title}
              style={styles.heroImg}
              width={720}
              height={1280}
              loading="eager"
            />
            <BackButton />
          </div>

          <div style={styles.content}>
            <div style={styles.genreList}>
              {movie.genres.map((g) => (
                <span key={g} style={styles.badge}>{g}</span>
              ))}
            </div>
            <h1 style={styles.title}>{movie.title}</h1>
            {movie.actresses.length > 0 && (
              <p style={styles.actress}>👤 {movie.actresses.join(" / ")}</p>
            )}
            {movie.description && (
              <p style={styles.description}>{movie.description}</p>
            )}
            <div style={styles.ctaArea}>
              <AffiliateLink href={movie.affiliate_url} slug={movie.slug} title={movie.title} />
            </div>
          </div>
        </main>
        <style>{pageCSS}</style>
      </>
    );
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") notFound();
    throw error;
  }
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    // bodyはスクロールさせず、mainで閉じ込めることで fixed Header と競合しない
    position: 'fixed' as const,
    top: '52px' as unknown as string,
    left: 0,
    right: 0,
    bottom: 0,
    overflowY: 'auto' as const,
    background: '#0a0a0a',
    color: '#fff',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    WebkitOverflowScrolling: 'touch' as unknown as string,
  },
  heroWrap: {
    position: 'relative',
    width: '100%',
    // 85svh → 55svh に縮小
    height: '55svh' as unknown as string,
    overflow: 'hidden',
    background: '#111',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroBgBlur: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    filter: 'blur(24px) brightness(0.3)',
    transform: 'scale(1.1)',
    display: 'block',
  },
  heroImg: {
    position: 'relative',
    zIndex: 1,
    width: 'auto' as unknown as string,
    height: '100%',
    maxWidth: 'calc(100% - 60px)' as unknown as string,
    maxHeight: 'calc(55svh - 32px)' as unknown as string,
    objectFit: 'contain',
    display: 'block',
    borderRadius: '8px',
  },
  content: {
    padding: '20px 16px 48px',
    width: '100%',
    boxSizing: 'border-box',
  },
  genreList: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '14px' },
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
    fontSize: 'clamp(18px, 5vw, 26px)' as unknown as string,
    fontWeight: 700,
    lineHeight: 1.35,
    marginBottom: '10px',
    color: '#fff',
  },
  actress: { fontSize: '13px', color: 'rgba(255,255,255,0.55)', marginBottom: '16px' },
  description: {
    fontSize: '14px',
    lineHeight: 1.8,
    color: 'rgba(255,255,255,0.6)',
    marginBottom: '28px',
    borderTop: '1px solid rgba(255,255,255,0.08)',
    paddingTop: '20px',
  },
  ctaArea: { display: 'flex', flexDirection: 'column' as const, gap: '12px' },
};

const pageCSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    background: #0a0a0a !important;
    overflow: hidden !important;
  }

  .affiliate-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 52px;
    padding: 0 16px;
    background: #e91e63;
    color: #fff;
    font-size: 16px;
    font-weight: 700;
    border-radius: 12px;
    text-align: center;
    text-decoration: none;
    transition: opacity 0.15s ease, transform 0.15s ease;
    box-sizing: border-box;
  }
  .affiliate-btn:active { opacity: 0.75; transform: scale(0.98); }
  @media (hover: hover) { .affiliate-btn:hover { opacity: 0.88; } }
`;
