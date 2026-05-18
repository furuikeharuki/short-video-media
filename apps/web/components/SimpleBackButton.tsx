"use client";

/**
 * シンプルな戻るボタン (検索結果サブヘッダー / リスト画面 / ホームセクション一覧 で共通利用)。
 *
 * - ブラウザ履歴 back を呼ぶ。履歴が無い場合は `/` にフォールバック。
 * - 左上に置く前提でデフォルトでは `position: static` の inline-flex。
 *   親側 (.sr-subheader 等) で `display: flex; align-items: center` していれば縦中央揃え。
 */

import { useCallback } from "react";
import { useRouter } from "next/navigation";

type Props = {
  /** aria-label。デフォルト "戻る"。 */
  label?: string;
  /** クリック時のフォールバック先 URL。デフォルト "/" 。 */
  fallbackHref?: string;
};

export default function SimpleBackButton({
  label = "戻る",
  fallbackHref = "/",
}: Props) {
  const router = useRouter();
  const handleClick = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push(fallbackHref);
    }
  }, [router, fallbackHref]);

  return (
    <button
      type="button"
      className="sbb-btn"
      aria-label={label}
      onClick={handleClick}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.2"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="15 6 9 12 15 18" />
      </svg>
      <style>{css}</style>
    </button>
  );
}

const css = `
  .sbb-btn {
    background: transparent;
    border: none;
    color: #fff;
    width: 36px;
    height: 36px;
    border-radius: 8px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    -webkit-tap-highlight-color: transparent;
  }
  .sbb-btn:hover {
    background: rgba(255,255,255,0.08);
  }
`;
