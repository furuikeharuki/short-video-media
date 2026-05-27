"use client";

import Link from "next/link";
import type { ActressCard } from "@/lib/api/home";

type Props = {
  actress: ActressCard;
  /** ランキング順位 (1始まり)。指定時は左上にバッジ表示。 */
  rank?: number;
};

/**
 * 人気女優セクションで使う横スクロール用カード。
 * 女優の image_url_large / image_url_small は DMM 由来でほぼ正方形 (約 600x600)
 * のため、サムネ枠も 1:1 にして元画像のアスペクトに合わせる。
 * 横幅は MovieCardThumb (140px) と揃え、横スクロール時のリズムを保つ。
 * リンクは女優詳細ページに飛ばす。
 */
export default function ActressCardThumb({ actress, rank }: Props) {
  const imgSrc =
    actress.image_url_large ??
    actress.image_url_small ??
    actress.thumbnail_url ??
    "";
  const href = `/actresses/${encodeURIComponent(actress.name)}`;

  return (
    <Link href={href} className="act" aria-label={actress.name}>
      <div className="act-thumb">
        {imgSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imgSrc} alt={actress.name} loading="lazy" />
        ) : (
          <div className="act-thumb-placeholder" />
        )}
        {rank != null && (
          <span className={`act-rank ${rank <= 3 ? "act-rank--top" : ""}`}>
            {rank}
          </span>
        )}
      </div>
      <div className="act-name" title={actress.name}>
        {actress.name}
      </div>
      <style>{styles}</style>
    </Link>
  );
}

const styles = `
  .act {
    flex: 0 0 auto;
    width: 140px;
    display: block;
    text-decoration: none;
    color: #fff;
    -webkit-tap-highlight-color: transparent;
  }
  .act-thumb {
    position: relative;
    width: 100%;
    /* 元画像が正方形なので 1:1 枠にして上下のトリミングを最小化する。
       (旧: 9/16 縦長枠だと顔の上下が大きく切れていた) */
    aspect-ratio: 1 / 1;
    border-radius: 10px;
    overflow: hidden;
    background: #111;
  }
  .act-thumb img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center center;
  }
  .act-thumb-placeholder {
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, #222, #111);
  }
  .act-rank {
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
  .act-rank--top {
    background: linear-gradient(135deg, #e91e63, #ff5174);
  }
  .act-name {
    margin-top: 6px;
    font-size: 13px;
    line-height: 1.3;
    font-weight: 600;
    color: #fff;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
`;
