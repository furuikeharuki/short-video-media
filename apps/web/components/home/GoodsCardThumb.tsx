"use client";

import type { GoodsCard } from "@/lib/api/home";
import { trackEvent } from "@/lib/analytics/analytics";

type Props = {
  goods: GoodsCard;
  /** ランキング順位 (1始まり)。指定時は左上にバッジ表示。 */
  rank?: number;
};

/**
 * 人気商品セクションで使う横スクロール用カード。
 * 商品 (Goods) は動画ではなく FANZA mono/goods フロアの物販なので、
 * タップで再生せずアフィリエイト URL に直接遷移させる。
 * 商品画像は基本正方形なので 1:1 枠で表示し、人気女優カードと並びを揃える。
 */
export default function GoodsCardThumb({ goods, rank }: Props) {
  const imgSrc = goods.image_url_large ?? goods.image_url_list ?? "";
  const safeHref =
    typeof goods.affiliate_url === "string" ? goods.affiliate_url.trim() : "";

  const handleClick = () => {
    if (!safeHref) return;
    void trackEvent("affiliate_click", {
      slug: goods.slug,
      title: goods.title,
      affiliate_url: safeHref,
    });
  };

  const inner = (
    <>
      <div className="gct-thumb">
        {imgSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imgSrc} alt={goods.title} loading="lazy" />
        ) : (
          <div className="gct-thumb-fallback" aria-hidden="true" />
        )}
        {rank != null && (
          <span className={`gct-rank ${rank <= 3 ? "gct-rank--top" : ""}`}>
            {rank}
          </span>
        )}
      </div>
      <div className="gct-meta">
        <p className="gct-title" title={goods.title}>
          {goods.title}
        </p>
        {goods.price_min != null && (
          <p className="gct-price">¥{goods.price_min.toLocaleString()}</p>
        )}
      </div>
      <style>{styles}</style>
    </>
  );

  if (!safeHref) {
    return (
      <div className="gct gct--disabled" aria-label={goods.title}>
        {inner}
      </div>
    );
  }

  return (
    <a
      href={safeHref}
      target="_blank"
      // FANZA mono/goods のアフィリエイト遷移。
      // sponsored: Google ガイドライン / noopener noreferrer: target=_blank セキュリティ対策。
      rel="noopener noreferrer sponsored"
      onClick={handleClick}
      className="gct"
      aria-label={goods.title}
    >
      {inner}
    </a>
  );
}

const styles = `
  .gct {
    flex: 0 0 auto;
    width: 140px;
    display: block;
    text-decoration: none;
    color: #fff;
    -webkit-tap-highlight-color: transparent;
  }
  .gct--disabled {
    opacity: 0.5;
    cursor: default;
  }
  .gct-thumb {
    position: relative;
    width: 100%;
    /* 商品画像は正方形なので 1:1 枠にして、人気女優カードと揃える。 */
    aspect-ratio: 1 / 1;
    border-radius: 10px;
    overflow: hidden;
    background: #111;
  }
  .gct-thumb img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center center;
    background: #111;
  }
  .gct-thumb-fallback {
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, #1a1a1a, #2a2a2a);
  }
  .gct-rank {
    position: absolute;
    z-index: 2;
    top: 6px; left: 6px;
    min-width: 24px; height: 24px;
    padding: 0 6px;
    display: inline-flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.7);
    color: #fff;
    font-size: 13px;
    font-weight: 800;
    border-radius: 6px;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }
  .gct-rank--top {
    background: linear-gradient(135deg, #e91e63, #ff5174);
  }
  .gct-meta {
    margin-top: 8px;
    padding: 0 2px;
  }
  .gct-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.35;
    color: #fff;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    word-break: break-word;
  }
  .gct-price {
    margin: 4px 0 0;
    font-size: 12px;
    font-weight: 700;
    color: #ff9d3f;
  }
`;
