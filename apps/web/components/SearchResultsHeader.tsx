"use client";

/**
 * 検索結果ページ専用のサブヘッダー (大改修後)。
 *
 * 役割を縮小:
 *   - 左: 戻るボタン (ブラウザ履歴 back)
 *   - 中央: 現在のキーワード/ジャンル/フィールド名のラベル
 *
 * フィルター UI は Header 上の `GlobalFilterButton` に集約されたので、
 * このサブヘッダーは戻るボタン + ラベルだけ持つ純粋なバーになる。
 */

import SimpleBackButton from "@/components/SimpleBackButton";

type Props = {
  /** 左側に表示するラベル (例: 「妹」 / #プロ女優 / 監督「苺原」)。空ならラベル省略。 */
  label: string;
};

export default function SearchResultsHeader({ label }: Props) {
  return (
    <>
      <div className="sr-subheader">
        <SimpleBackButton />
        <div className="sr-label" title={label}>{label}</div>
      </div>

      <style>{css}</style>
    </>
  );
}

const css = `
  .sr-subheader {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #0a0a0a;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    min-height: 44px;
  }
  .sr-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #fff;
    font-size: 14px;
    font-weight: 600;
  }
`;
