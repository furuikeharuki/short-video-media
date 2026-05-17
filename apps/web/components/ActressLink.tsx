"use client";

import Link from "next/link";
import type { ReactNode, CSSProperties } from "react";

/**
 * 女優詳細ページへのリンク。
 * クリック時に「戻り先URL」(= 現在のページURL) を sessionStorage に保存しておき、
 * 女優詳細ページの戻るボタンで確実に元の動画詳細ページに戻れるようにする。
 */
interface Props {
  name: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export const ACTRESS_BACK_TO_KEY = "actress_back_to";

export default function ActressLink({ name, className, style, children }: Props) {
  const href = `/actresses/${encodeURIComponent(name)}`;
  return (
    <Link
      href={href}
      className={className}
      style={style}
      prefetch={false}
      onClick={() => {
        try {
          if (typeof window !== "undefined") {
            // 動画詳細・モーダル等から女優ページに遷移する際の戻り先URLを記録
            sessionStorage.setItem(
              ACTRESS_BACK_TO_KEY,
              window.location.pathname + window.location.search,
            );
          }
        } catch {
          // sessionStorage が無効なブラウザでは何もしない (router.back() に fallback)
        }
      }}
    >
      {children}
    </Link>
  );
}
