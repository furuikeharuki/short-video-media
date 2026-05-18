"use client";

import { useRouter } from "next/navigation";
import type { ReactNode, CSSProperties, MouseEvent } from "react";

/**
 * 女優詳細ページへのリンク。
 *
 * 動画詳細モーダル (インターセプトルート @modal/(.)movies/[slug]) 内から
 * Next.js の <Link> でクライアントナビゲートすると、モーダルが残ったまま
 * URL バーが更新されない問題があるため、明示的に履歴を操作する:
 *   1. window.history.back() でモーダルを閉じる (= モーダル裏のフィード等に戻る)
 *   2. その直後に router.push で女優ページへ遷移
 *
 * モーダル外 (動画詳細フルページ、検索結果等) からのクリックでも同じ動きにできるが、
 * 履歴の back が意図しない遷移を起こすため、URL が /movies/ で始まるとき (= モーダル中) だけ
 * back を挟む。それ以外は router.push のみ。
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
      const isInMovieModal = window.location.pathname.startsWith("/movies/");
      if (isInMovieModal) {
        // モーダルを閉じてから女優ページへ。
        // back() の戻り先 (= フィード等) が history に存在する前提。
        window.history.back();
        // popstate が完了するのを 1 frame 待ってから push する。
        // requestAnimationFrame 1 回だと早すぎることがあるため setTimeout で確実に待つ。
        setTimeout(() => {
          router.push(href);
        }, 50);
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
