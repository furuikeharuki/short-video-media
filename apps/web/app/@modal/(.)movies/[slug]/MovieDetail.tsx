"use client";

import { useRouter } from "next/navigation";
import AffiliateLink from "@/components/analytics/affiliate-link";
import DetailViewTracker from "@/components/analytics/detail-view-tracker";
import type { MovieDetail as MovieDetailType } from "@/lib/api/movies";
import type { CSSProperties } from "react";

const NA = "----";

function formatDate(dateStr: string | null): string {
  if (!dateStr) return NA;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return NA;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export default function MovieDetail({ movie }: { movie: MovieDetailType }) {
  const router = useRouter();

  const imgSrc = movie.image_url_large ?? movie.image_url_list ?? "";
  const price = movie.price_list?.sale_price ?? movie.price_list?.list_price ?? movie.price_min;
  const hasReview = movie.review_count > 0 && movie.review_average != null;

  const metaRows: { label: string; value: React.ReactNode }[] = [
    { label: "出演",       value: movie.actresses.length > 0 ? movie.actresses.join(" / ") : NA },
    { label: "シリーズ",   value: movie.series_name ?? NA },
    { label: "監督",       value: movie.director_name ?? NA },
    { label: "メーカー",   value: movie.maker_name ?? NA },
    { label: "レーベル",   value: movie.label_name ?? NA },
    { label: "収録時間",   value: movie.volume != null ? `${movie.volume}分` : NA },
    { label: "配信開始日", value: formatDate(movie.delivery_date) },
    { label: "商品発売日", value: formatDate(movie.release_date) },
    { label: "メーカー品番", value: movie.maker_product ?? NA },
  ];

  return (
    <>
      <DetailViewTracker slug={movie.slug} title={movie.title} />

      <div style={heroWrapStyle}>
        <img src={imgSrc} alt="" aria-hidden="true" style={heroBgStyle} />
        <img
          src={imgSrc}
          alt={movie.title}
          style={heroImgStyle}
          width={720}
          height={1280}
          loading="eager"
        />
        <button
          onClick={() => router.back()}
          aria-label="フィードに戻る"
          style={backBtnStyle}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
        </button>
      </div>

      <div style={contentStyle}>
        <div style={genreListStyle}>
          {movie.genres.map((g) => (
            <span key={g} style={badgeStyle}>{g}</span>
          ))}
        </div>

        <h1 style={titleStyle}>{movie.title}</h1>

        <div style={scoreAreaStyle}>
          {hasReview && (
            <div style={scoreItemStyle}>
              <span style={starsStyle}>
                {"★".repeat(Math.round(movie.review_average!))}
                {"☆".repeat(5 - Math.round(movie.review_average!))}
              </span>
              <span style={reviewNumStyle}>
                {movie.review_average!.toFixed(1)} ({movie.review_count}件)
              </span>
            </div>
          )}
          {price != null && (
            <div style={priceStyle}>¥{price.toLocaleString()}</div>
          )}
        </div>

        <div style={metaTableStyle}>
          {metaRows.map(({ label, value }) => (
            <div key={label} style={metaRowStyle}>
              <span style={metaLabelStyle}>{label}</span>
              <span style={metaValueStyle}>{value}</span>
            </div>
          ))}
        </div>

        {movie.description && (
          <p style={descStyle}>{movie.description}</p>
        )}

        <div style={ctaStyle}>
          <AffiliateLink
            href={movie.affiliate_url}
            slug={movie.slug}
            title={movie.title}
          />
        </div>
      </div>

      <style>{modalCSS}</style>
    </>
  );
}

const heroWrapStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "55svh",
  overflow: "hidden",
  background: "#111",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const heroBgStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  objectFit: "cover",
  filter: "blur(24px) brightness(0.3)",
  transform: "scale(1.1)",
  display: "block",
};

const heroImgStyle: CSSProperties = {
  position: "relative",
  zIndex: 1,
  width: "auto",
  height: "100%",
  maxWidth: "calc(100% - 60px)",
  objectFit: "contain",
  display: "block",
  borderRadius: "8px",
};

const backBtnStyle: CSSProperties = {
  position: "absolute",
  top: "16px",
  left: "16px",
  zIndex: 2,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "40px",
  height: "40px",
  borderRadius: "50%",
  background: "rgba(0,0,0,0.5)",
  backdropFilter: "blur(8px)",
  color: "#fff",
  border: "1px solid rgba(255,255,255,0.15)",
  cursor: "pointer",
};

const contentStyle: CSSProperties = {
  padding: "20px 16px 48px",
  width: "100%",
  boxSizing: "border-box",
};

const genreListStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "6px",
  marginBottom: "14px",
};

const badgeStyle: CSSProperties = {
  display: "inline-block",
  background: "rgba(255,255,255,0.1)",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "rgba(255,255,255,0.7)",
  fontSize: "11px",
  fontWeight: 600,
  letterSpacing: "0.05em",
  padding: "3px 10px",
  borderRadius: "999px",
};

const titleStyle: CSSProperties = {
  fontSize: "clamp(18px, 5vw, 26px)",
  fontWeight: 700,
  lineHeight: 1.35,
  marginBottom: "12px",
  color: "#fff",
};

const scoreAreaStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "16px",
  marginBottom: "20px",
};

const scoreItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
};

const starsStyle: CSSProperties = {
  color: "#f5c518",
  fontSize: "14px",
  letterSpacing: "1px",
};

const reviewNumStyle: CSSProperties = {
  fontSize: "12px",
  color: "rgba(255,255,255,0.45)",
};

const priceStyle: CSSProperties = {
  fontSize: "16px",
  fontWeight: 700,
  color: "#e91e63",
};

const metaTableStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0",
  marginBottom: "24px",
  borderTop: "1px solid rgba(255,255,255,0.08)",
};

const metaRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "12px",
  padding: "10px 0",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
};

const metaLabelStyle: CSSProperties = {
  fontSize: "11px",
  fontWeight: 600,
  color: "rgba(255,255,255,0.35)",
  letterSpacing: "0.06em",
  minWidth: "72px",
  paddingTop: "1px",
  flexShrink: 0,
};

const metaValueStyle: CSSProperties = {
  fontSize: "13px",
  color: "rgba(255,255,255,0.75)",
  lineHeight: 1.6,
  wordBreak: "break-all",
};

const descStyle: CSSProperties = {
  fontSize: "14px",
  lineHeight: 1.8,
  color: "rgba(255,255,255,0.6)",
  marginBottom: "28px",
};

const ctaStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

const modalCSS = `
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
