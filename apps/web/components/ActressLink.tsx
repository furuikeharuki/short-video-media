"use client";

import { useRouter } from "next/navigation";
import type { ReactNode, CSSProperties, MouseEvent } from "react";

/**
 * 女優詳細ページへのリンク。
 *
 * フィード上の動画詳細モーダル (MovieDetailModal) は window.history.pushState で
 * URL バーだけを /movies/X に書き換えており、Next.js ルータ (usePathname) は
 * 元の /feed... を返したまま。さらに、モーダル unmount 時に
 * history.replaceState(null, "", prev) で URL を元に戻す副作用がある。
 *
 * そのため、モーダル中にこのリンクから router.push しても:
 *   1) router.push で Next.js が /actresses/X へ遷移開始
 *   2) その途中で MovieDetailModal が unmount → replaceState で URL を /feed... に戻す
 *   3) 結果として URL は /feed... のまま、ページ内容も /actresses/X ではなく
 *      モーダル裏のフィードが見えてしまう
 *
 * 対策: 実 URL バー (window.location.pathname) が /movies/ で始まっているとき
 * (= モーダル中) は、フルページ遷移 window.location.assign を使う。
 * これなら React の unmount 処理が走らず、ブラウザがそのまま /actresses/X へ移動する。
 *
 * モーダル外 (フィード本体・検索結果・女優ページ間遷移など) からは
 * 通常通り router.push で SPA 遷移。
 *
 * <a href> を残すことで、middle-click / Cmd+click による新規タブ起動など
 * ネイティブのリンク機能も維持する。
 */
interface Props {
  name: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export default function ActressLink({ name, className, style, children }: Props) {
  const router = useRouter();
  const href = `/actresses/${encodeURIComponent(name)}`;

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // 修飾キー付きクリック (新規タブ等) はブラウザのデフォルト動作に任せる
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

    if (typeof window !== "undefined") {
      // pushState で URL だけ書き換えられたモーダルの中にいるかを「実 URL バー」で判定
      const realPath = window.location.pathname;
      if (realPath.startsWith("/movies/")) {
        window.location.assign(href);
        return;
      }
    }

    router.push(href);
  };

  return (
    <a href={href} onClick={handleClick} className={className} style={style}>
      {children}
    </a>
  );
}
