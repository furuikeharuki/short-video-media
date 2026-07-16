"use client";

import { useRouter } from "next/navigation";
import AffiliateLink from "@/components/analytics/affiliate-link";
import ActressLink from "@/components/ActressLink";
import AdSlot from "@/components/ads/AdSlot";
import ExpandableText from "@/components/ExpandableText";
import { navigateRespectingModal } from "@/lib/modalNav";
import { generateIntro } from "@/lib/movieIntro";
import { buildRecommendations } from "@/lib/movieRecommend";
import type { MovieDetail } from "@/lib/api/movies";
import type { MouseEvent } from "react";

const NA = "----";

function formatDate(dateStr: string | null): string {
  if (!dateStr) return NA;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return NA;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

interface Props {
  movie: MovieDetail;
}

export default function MovieDetailContent({ movie }: Props) {
  const router = useRouter();
  const imgSrc = movie.image_url_large ?? movie.image_url_list ?? "";
  const price = movie.price_list?.sale_price ?? movie.price_list?.list_price ?? movie.price_min;
  const hasReview = movie.review_count > 0 && movie.review_average != null;

  // 作品詳細ページと同じルールベース生成 (LLM 不使用 / レンダリング時生成 / DB 保存なし)。
  const introText = generateIntro({
    title: movie.title,
    slug: movie.slug,
    actresses: movie.actresses,
    genres: movie.genres,
    product_id: movie.product_id,
    maker_product: movie.maker_product,
    label_name: movie.label_name,
    maker_name: movie.maker_name,
    volume: movie.volume,
    price_min: movie.price_min,
    price_list: movie.price_list
      ? {
          list_price: movie.price_list.list_price,
          sale_price: movie.price_list.sale_price,
        }
      : null,
    delivery_date: movie.delivery_date,
    release_date: movie.release_date,
    primary_date: movie.primary_date,
  });
  const recommendations = buildRecommendations(movie.genres);

  // モーダル中 (URL バーが /movies/ から始まる) では Next の <Link> や router.push を使うと
  // MovieDetailModal の unmount 時に replaceState で URL が巻き戻されて遷移が打ち消される。
  // ActressLink と同じく window.location.assign でフルページ遷移にすることで回避する。
  const fieldLink = (
    field: "director" | "maker" | "label" | "series",
    value: string,
  ) => {
    const href = `/search?${field}=${encodeURIComponent(value)}`;
    const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }
      e.preventDefault();
      navigateRespectingModal(href, () => router.push(href));
    };
    return (
      <a href={href} onClick={handleClick} className="mdc-meta-link">
        {value}
      </a>
    );
  };

  const actressLinks = (names: string[]): React.ReactNode => (
    <>
      {names.map((n, i) => (
        <span key={`${n}-${i}`}>
          <ActressLink name={n} className="mdc-meta-link">
            {n}
          </ActressLink>
          {i < names.length - 1 && " / "}
        </span>
      ))}
    </>
  );

  const metaRows: { label: string; value: React.ReactNode }[] = [
    { label: "出演",         value: movie.actresses.length > 0 ? actressLinks(movie.actresses) : NA },
    { label: "シリーズ",     value: movie.series_name ? fieldLink("series", movie.series_name) : NA },
    { label: "監督",         value: movie.director_name ? fieldLink("director", movie.director_name) : NA },
    { label: "メーカー",     value: movie.maker_name ? fieldLink("maker", movie.maker_name) : NA },
    { label: "レーベル",     value: movie.label_name ? fieldLink("label", movie.label_name) : NA },
    { label: "収録時間",     value: movie.volume != null ? `${movie.volume}分` : NA },
    { label: "配信開始日",   value: formatDate(movie.delivery_date) },
    { label: "商品発売日",   value: formatDate(movie.release_date) },
    // 配信品番:
    //   ラベルは「配信品番」(FANZA 配信時に付く品番) とする。表示値は DMM API の
    //   `maker_product` (メーカー品番) を優先し、欠落 (null / 空文字) のときは
    //   `product_id` (品番) にフォールバックする。実データでは `maker_product` が
    //   空で `product_id` だけ入っているケースが多いため (app テスト fixture も
    //   この形)。`??` ではなく `||` を使うことで空文字 `""` も空扱いにする。
    { label: "配信品番", value: movie.maker_product || movie.product_id || NA },
  ];

  return (
    <div className="mdc-root">
      <div className="mdc-hero">
        <img src={imgSrc} alt="" aria-hidden="true" className="mdc-hero-blur" />
        <img
          src={imgSrc}
          alt={`${movie.title}${movie.actresses.length > 0 ? ` - ${movie.actresses.join("・")}` : ""}`}
          className="mdc-hero-img"
          width={720}
          height={1280}
          loading="eager"
        />
      </div>

      <div className="mdc-body">
        <div className="mdc-genres">
          {movie.genres.map((g) => (
            <span key={g} className="mdc-badge">{g}</span>
          ))}
        </div>

        <h2 className="mdc-title">{movie.title}</h2>

        <div className="mdc-score">
          {hasReview && (
            <div className="mdc-score-item">
              <span className="mdc-stars">
                {"★".repeat(Math.round(movie.review_average!))}
                {"☆".repeat(5 - Math.round(movie.review_average!))}
              </span>
              <span className="mdc-review-num">
                {movie.review_average!.toFixed(1)} ({movie.review_count}件)
              </span>
            </div>
          )}
          {price != null && (
            <div className="mdc-price">¥{price.toLocaleString()}</div>
          )}
        </div>

        {(movie.dmm_description || introText) && (
          <section className="mdc-info-section">
            <h3 className="mdc-section-heading">作品紹介</h3>
            <ExpandableText text={movie.dmm_description || introText} />
          </section>
        )}

        {recommendations.length > 0 && (
          <section className="mdc-info-section">
            <h3 className="mdc-section-heading">こんな人におすすめ</h3>
            <ul className="mdc-recommend-list">
              {recommendations.map((line) => (
                <li key={line} className="mdc-recommend-item">{line}</li>
              ))}
            </ul>
          </section>
        )}

        <section className="mdc-meta-section">
          <h3 className="mdc-section-heading">作品情報</h3>
          <div className="mdc-meta-table">
            {metaRows.map(({ label, value }) => (
              <div key={label} className="mdc-meta-row">
                <span className="mdc-meta-label">{label}</span>
                <span className="mdc-meta-value">{value}</span>
              </div>
            ))}
          </div>
        </section>

        {movie.description && (
          <p className="mdc-description">{movie.description}</p>
        )}

        <div className="mdc-ad-bottom">
          <AdSlot zone="mobileBanner300x250" />
        </div>

        <div className="mdc-cta">
          <AffiliateLink href={movie.affiliate_url} slug={movie.slug} title={movie.title} />
        </div>
      </div>

      <style>{`
        .mdc-root { display: flex; flex-direction: column; width: 100%; overflow-x: hidden; }
        .mdc-hero {
          position: relative; width: 100%; height: 50svh;
          overflow: hidden; background: #111;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0;
        }
        .mdc-hero-blur {
          position: absolute; inset: 0; width: 100%; height: 100%;
          object-fit: cover; filter: blur(24px) brightness(0.3);
          transform: scale(1.1); display: block;
        }
        .mdc-hero-img {
          position: relative; z-index: 1; width: auto; height: 100%;
          max-width: calc(100% - 60px); object-fit: contain;
          display: block; border-radius: 8px;
        }
        .mdc-body {
          padding: 20px 16px 24px;
          overflow-x: hidden;
          box-sizing: border-box;
          width: 100%;
        }
        .mdc-genres { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
        .mdc-badge {
          display: inline-block; background: rgba(255,255,255,0.1);
          border: 1px solid rgba(255,255,255,0.2); color: rgba(255,255,255,0.7);
          font-size: 11px; font-weight: 600; letter-spacing: 0.05em;
          padding: 3px 10px; border-radius: 999px;
        }
        .mdc-title {
          font-size: clamp(18px, 5vw, 26px); font-weight: 700;
          line-height: 1.35; margin-bottom: 12px; color: #fff;
        }
        .mdc-score { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
        .mdc-score-item { display: flex; align-items: center; gap: 6px; }
        .mdc-stars { color: #f5c518; font-size: 14px; letter-spacing: 1px; }
        .mdc-review-num { font-size: 12px; color: rgba(255,255,255,0.45); }
        .mdc-price { font-size: 16px; font-weight: 700; color: #e91e63; }
        .mdc-meta-section { margin-bottom: 24px; }
        .mdc-info-section { margin-bottom: 28px; }
        .mdc-section-heading {
          font-size: 13px; font-weight: 700; color: rgba(255,255,255,0.85);
          letter-spacing: 0.06em; margin-bottom: 10px;
        }
        .mdc-recommend-list {
          list-style: none; display: flex; flex-direction: column; gap: 8px;
        }
        .mdc-recommend-item {
          font-size: 13px; line-height: 1.6; color: rgba(255,255,255,0.72);
          padding-left: 18px; position: relative;
        }
        .mdc-recommend-item::before {
          content: "✓"; position: absolute; left: 0;
          color: #7cb7ff; font-weight: 700;
        }
        .mdc-meta-table {
          display: flex; flex-direction: column; gap: 0;
          margin-bottom: 24px; border-top: 1px solid rgba(255,255,255,0.08);
        }
        .mdc-meta-section .mdc-meta-table { margin-bottom: 0; }
        .mdc-meta-row {
          display: flex; align-items: flex-start; gap: 12px;
          padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .mdc-meta-label {
          font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.35);
          letter-spacing: 0.06em; min-width: 72px; padding-top: 1px; flex-shrink: 0;
        }
        .mdc-meta-value {
          font-size: 13px; color: rgba(255,255,255,0.75);
          line-height: 1.6; word-break: break-all;
        }
        .mdc-meta-link {
          color: #7cb7ff; text-decoration: none;
          border-bottom: 1px solid rgba(124,183,255,0.3);
        }
        .mdc-meta-link:active { opacity: 0.7; }
        .mdc-description {
          font-size: 14px; line-height: 1.8; color: rgba(255,255,255,0.6);
          margin-bottom: 20px;
        }
        .mdc-cta { display: flex; flex-direction: column; gap: 12px; }
        .mdc-ad-bottom {
          margin-top: 24px;
          margin-bottom: 10px;
          width: 100%;
          display: flex;
          justify-content: center;
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
      `}</style>
    </div>
  );
}
