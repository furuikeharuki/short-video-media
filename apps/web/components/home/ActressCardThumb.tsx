"use client";

import Link from "next/link";
import type { ActressCard } from "@/lib/api/home";

type Props = {
  actress: ActressCard;
};

/**
 * 人気女優セクションで使う横スクロール用カード。
 * MovieCardThumb と並べたときに視覚的に統一感が出るよう、
 * 同じ 140px 幅・縦長サムネ枠を使う。リンクは女優詳細ページに飛ばす。
 */
export default function ActressCardThumb({ actress }: Props) {
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
    aspect-ratio: 9 / 16;
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
    object-position: center top;
  }
  .act-thumb-placeholder {
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, #222, #111);
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
