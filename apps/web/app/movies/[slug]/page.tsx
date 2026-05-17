import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";

import AffiliateLink from "@/components/analytics/affiliate-link";
import DetailViewTracker from "@/components/analytics/detail-view-tracker";
import BackButton from "@/components/BackButton";
import ActressLink from "@/components/ActressLink";
import { getMovieBySlug } from "@/lib/api/movies";

const SITE_NAME = "AV Shorts";
const SITE_URL = "https://av-shorts.com";

type PageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  try {
    const { slug } = await params;
    const movie = await getMovieBySlug(slug);
    const title = `${movie.title} | ${SITE_NAME}`;
    const description = movie.description
      ? movie.description.slice(0, 120) + "..."
      : `${movie.actresses.join("・")}出演。${movie.maker_name ?? ""}の作品をショート動画で試し見できます。`;
    const imageUrl = movie.image_url_large ?? movie.image_url_list ?? "";
    const canonical = `${SITE_URL}/movies/${slug}`;

    return {
      title,
      description,
      alternates: { canonical },
      openGraph: {
        type: "video.other",
        url: canonical,
        title,
        description,
        images: imageUrl ? [{ url: imageUrl, width: 720, height: 1280, alt: movie.title }] : [],
        siteName: SITE_NAME,
        locale: "ja_JP",
      },
      twitter: {
        card: "summary_large_image",
        title,
        description,
        images: imageUrl ? [imageUrl] : [],
      },
    };
  } catch {
    return { title: SITE_NAME };
  }
}

const NA = "----";

function formatDate(dateStr: string | null): string {
  if (!dateStr) return NA;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return NA;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export default async function MovieDetailPage({ params }: PageProps) {
  const { slug } = await params;

  try {
    const movie = await getMovieBySlug(slug);
    const imgSrc = movie.image_url_large ?? movie.image_url_list ?? "";
    const price = movie.price_list?.sale_price ?? movie.price_list?.list_price ?? movie.price_min;
    const hasReview = movie.review_count > 0 && movie.review_average != null;
    const canonical = `${SITE_URL}/movies/${slug}`;

    const fieldLink = (field: "director" | "maker" | "label", value: string) => (
      <Link
        href={`/search?${field}=${encodeURIComponent(value)}`}
        style={styles.metaLink}
      >
        {value}
      </Link>
    );

    // 出演女優を女優詳細ページへリンク化
    // ActressLink を使うことで、クリック時に現在の動画詳細URLをsessionStorageに保存し、
    // 女優詳細ページの戻るボタンで確実にこの動画詳細ページに戻れるようにする。
    const actressLinks = (names: string[]): React.ReactNode => (
      <>
        {names.map((n, i) => (
          <span key={`${n}-${i}`}>
            <ActressLink name={n} style={styles.metaLink}>
              {n}
            </ActressLink>
            {i < names.length - 1 && " / "}
          </span>
        ))}
      </>
    );

    const metaRows: { label: string; value: React.ReactNode }[] = [
      { label: "出演",       value: movie.actresses.length > 0 ? actressLinks(movie.actresses) : NA },
      { label: "シリーズ",   value: movie.series_name ?? NA },
      { label: "監督",       value: movie.director_name ? fieldLink("director", movie.director_name) : NA },
      { label: "メーカー",   value: movie.maker_name ? fieldLink("maker", movie.maker_name) : NA },
      { label: "レーベル",   value: movie.label_name ? fieldLink("label", movie.label_name) : NA },
      { label: "収録時間",   value: movie.volume != null ? `${movie.volume}分` : NA },
      { label: "配信開始日", value: formatDate(movie.delivery_date) },
      { label: "商品発売日", value: formatDate(movie.release_date) },
      { label: "メーカー品番", value: movie.maker_product ?? NA },
    ];

    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "VideoObject",
      name: movie.title,
      description: movie.description ?? `${movie.actresses.join("・")}出演作品`,
      thumbnailUrl: imgSrc,
      uploadDate: movie.delivery_date ?? movie.release_date ?? "",
      duration: movie.volume ? `PT${movie.volume}M` : undefined,
      contentUrl: canonical,
      embedUrl: canonical,
      author: {
        "@type": "Organization",
        name: movie.maker_name ?? SITE_NAME,
      },
      aggregateRating: hasReview ? {
        "@type": "AggregateRating",
        ratingValue: movie.review_average,
        reviewCount: movie.review_count,
        bestRating: 5,
        worstRating: 1,
      } : undefined,
    };

    return (
      <>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <link rel="canonical" href={canonical} />
        <main style={styles.main}>
          <DetailViewTracker slug={movie.slug} title={movie.title} />

          <div style={styles.heroWrap}>
            <img
              src={imgSrc}
              alt={`${movie.title} サムネイル`}
              aria-hidden="true"
              style={styles.heroBgBlur}
            />
            <img
              src={imgSrc}
              alt={`${movie.title}${movie.actresses.length > 0 ? ` - ${movie.actresses.join("・")}` : ""}`}
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

            <div style={styles.scoreArea}>
              {hasReview && (
                <div style={styles.scoreItem}>
                  <span style={styles.stars}>
                    {"★".repeat(Math.round(movie.review_average!))}
                    {"☆".repeat(5 - Math.round(movie.review_average!))}
                  </span>
                  <span style={styles.reviewNum}>
                    {movie.review_average!.toFixed(1)} ({movie.review_count}件)
                  </span>
                </div>
              )}
              {price != null && (
                <div style={styles.price}>¥{price.toLocaleString()}</div>
              )}
            </div>

            <div style={styles.metaTable}>
              {metaRows.map(({ label, value }) => (
                <div key={label} style={styles.metaRow}>
                  <span style={styles.metaLabel}>{label}</span>
                  <span style={styles.metaValue}>{value}</span>
                </div>
              ))}
            </div>

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
    position: 'fixed' as const,
    // ヘッダーの実高さにピッタリ描画させる
    top: 'var(--header-h, 52px)' as unknown as string,
    left: 0, right: 0, bottom: 0,
    overflowY: 'auto' as const,
    background: '#0a0a0a',
    color: '#fff',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  heroWrap: {
    position: 'relative', width: '100%', height: '55svh' as unknown as string,
    overflow: 'hidden', background: '#111',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  heroBgBlur: {
    position: 'absolute', inset: 0, width: '100%', height: '100%',
    objectFit: 'cover', filter: 'blur(24px) brightness(0.3)',
    transform: 'scale(1.1)', display: 'block',
  },
  heroImg: {
    position: 'relative', zIndex: 1, width: 'auto' as unknown as string,
    height: '100%', maxWidth: 'calc(100% - 60px)' as unknown as string,
    objectFit: 'contain', display: 'block', borderRadius: '8px',
  },
  content: {
    padding: '20px 16px',
    paddingBottom: 'calc(var(--bottom-nav-h, 56px) + env(safe-area-inset-bottom, 0px) + 10px)' as unknown as string,
    width: '100%',
    boxSizing: 'border-box' as const,
  },
  genreList: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '14px' },
  badge: {
    display: 'inline-block', background: 'rgba(255,255,255,0.1)',
    border: '1px solid rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.7)',
    fontSize: '11px', fontWeight: 600, letterSpacing: '0.05em',
    padding: '3px 10px', borderRadius: '999px',
  },
  title: {
    fontSize: 'clamp(18px, 5vw, 26px)' as unknown as string,
    fontWeight: 700, lineHeight: 1.35, marginBottom: '12px', color: '#fff',
  },
  scoreArea: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '20px' },
  scoreItem: { display: 'flex', alignItems: 'center', gap: '6px' },
  stars: { color: '#f5c518', fontSize: '14px', letterSpacing: '1px' },
  reviewNum: { fontSize: '12px', color: 'rgba(255,255,255,0.45)' },
  price: { fontSize: '16px', fontWeight: 700, color: '#e91e63' },
  metaTable: {
    display: 'flex', flexDirection: 'column' as const, gap: '0',
    marginBottom: '24px', borderTop: '1px solid rgba(255,255,255,0.08)',
  },
  metaRow: {
    display: 'flex', alignItems: 'flex-start', gap: '12px',
    padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  metaLabel: {
    fontSize: '11px', fontWeight: 600, color: 'rgba(255,255,255,0.35)',
    letterSpacing: '0.06em', minWidth: '72px', paddingTop: '1px', flexShrink: 0,
  },
  metaValue: {
    fontSize: '13px', color: 'rgba(255,255,255,0.75)',
    lineHeight: 1.6, wordBreak: 'break-all' as const,
  },
  metaLink: {
    color: '#7cb7ff', textDecoration: 'none', borderBottom: '1px solid rgba(124,183,255,0.3)',
  },
  description: {
    fontSize: '14px', lineHeight: 1.8, color: 'rgba(255,255,255,0.6)',
    marginBottom: '28px',
  },
  ctaArea: { display: 'flex', flexDirection: 'column' as const, gap: '12px' },
};

const pageCSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    background: #0a0a0a !important;
    overflow: visible !important;
    height: auto !important;
  }
  .affiliate-btn {
    display: flex; align-items: center; justify-content: center;
    width: 100%; min-height: 52px; padding: 0 16px;
    background: #e91e63; color: #fff; font-size: 16px; font-weight: 700;
    border-radius: 12px; text-align: center; text-decoration: none;
    transition: opacity 0.15s ease, transform 0.15s ease; box-sizing: border-box;
  }
  .affiliate-btn:active { opacity: 0.75; transform: scale(0.98); }
  @media (hover: hover) { .affiliate-btn:hover { opacity: 0.88; } }
`;
