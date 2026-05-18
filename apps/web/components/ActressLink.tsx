"use client";

import Link from "next/link";
import type { ReactNode, CSSProperties } from "react";

/**
 * 女優詳細ページへのリンク。
 * 通常の Link と同等だが、prefetch=false と「女優詳細用」という意味付けを明確にする。
 *
 * 戻る挙動はブラウザネイティブの履歴に任せる:
 *   モーダル/動画詳細から女優ページへ push → 戻る (ボタン or ブラウザバック) で元の URL に戻る。
 *   Next.js のインターセプトモーダルもこの方式で復元される。
 */
interface Props {
  name: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export default function ActressLink({ name, className, style, children }: Props) {
  const href = `/actresses/${encodeURIComponent(name)}`;
  return (
    <Link href={href} className={className} style={style} prefetch={false}>
      {children}
    </Link>
  );
}
