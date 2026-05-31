import type { NextDestinationKind } from "@/lib/age-gate/next-path";

/**
 * age-gate の背後にうっすら見せる「次の画面」のプレビュー。
 *
 * 設計方針 (安全性・パフォーマンス):
 *   - 実ページ・実コンテンツは一切ロードしない。遷移先タイプ (feed / movie /
 *     actress / search / list / home) に応じた **汎用スケルトン** を CSS だけで
 *     描画する。これにより確認前に露骨な内容が漏れることは原理上ありえない。
 *   - 画像・動画・iframe は使わない。autoplay も発生しない。重い media を抱えない
 *     ので age-gate の表示性能は劣化しない。
 *   - 全体を強いブラー + 暗転 + grayscale で「次に何か続きがある」気配だけ伝える。
 *   - `aria-hidden` かつ `pointer-events: none` で、支援技術・操作の両面から
 *     完全に不活性 (inert) にする。フォーカスは前面のカードの CTA に集約させる。
 */

type NextScreenPreviewProps = {
  kind: NextDestinationKind;
};

export default function NextScreenPreview({ kind }: NextScreenPreviewProps) {
  return (
    <div className="agp" aria-hidden="true">
      <div className="agp-inner">{renderSkeleton(kind)}</div>
      <style>{previewCss}</style>
    </div>
  );
}

function renderSkeleton(kind: NextDestinationKind) {
  switch (kind) {
    case "feed":
      return <FeedSkeleton />;
    case "movie":
      return <MovieSkeleton />;
    case "search":
      return <SearchSkeleton />;
    case "actress":
    case "list":
    case "genre":
    case "home":
    default:
      return <GridSkeleton />;
  }
}

// 縦スクロールフィード: 画面いっぱいの 1 枚 + 右側の操作列を模す。
function FeedSkeleton() {
  return (
    <div className="agp-feed">
      <div className="agp-feed-stage" />
      <div className="agp-feed-rail">
        <span className="agp-dot" />
        <span className="agp-dot" />
        <span className="agp-dot" />
      </div>
      <div className="agp-feed-caption">
        <div className="agp-line w70" />
        <div className="agp-line w40" />
      </div>
    </div>
  );
}

// 作品詳細: 大きなサムネ + タイトル行 + CTA ボタン帯を模す。
function MovieSkeleton() {
  return (
    <div className="agp-movie">
      <div className="agp-hero" />
      <div className="agp-line w80" />
      <div className="agp-line w50" />
      <div className="agp-cta" />
      <div className="agp-grid agp-grid-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="agp-tile" />
        ))}
      </div>
    </div>
  );
}

// 検索: 検索バー + 結果グリッドを模す。
function SearchSkeleton() {
  return (
    <div className="agp-search">
      <div className="agp-searchbar" />
      <div className="agp-grid agp-grid-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="agp-tile" />
        ))}
      </div>
    </div>
  );
}

// 一覧 / 女優 / ジャンル / ホーム: 見出し + カードグリッドを模す。
function GridSkeleton() {
  return (
    <div className="agp-listpage">
      <div className="agp-line w50 agp-heading" />
      <div className="agp-grid agp-grid-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="agp-tile" />
        ))}
      </div>
    </div>
  );
}

const previewCss = `
  .agp {
    position: fixed;
    inset: 0;
    z-index: 0;
    overflow: hidden;
    background: #0a0a0a;
    /* 確認前なので強くぼかし・減光し、内容を読めない状態にする */
    filter: blur(18px) brightness(0.5) grayscale(0.4);
    transform: scale(1.08); /* blur の端の透けを隠す */
    pointer-events: none;
    user-select: none;
  }
  .agp-inner {
    width: 100%;
    height: 100%;
    max-width: 480px;
    margin: 0 auto;
    padding: 24px 16px 80px;
    box-sizing: border-box;
  }
  .agp-line {
    height: 14px;
    border-radius: 7px;
    background: rgba(255,255,255,0.12);
    margin: 10px 0;
  }
  .agp-heading { height: 20px; }
  .w40 { width: 40%; }
  .w50 { width: 50%; }
  .w70 { width: 70%; }
  .w80 { width: 80%; }
  .agp-grid { display: grid; gap: 10px; margin-top: 14px; }
  .agp-grid-2 { grid-template-columns: repeat(2, 1fr); }
  .agp-grid-3 { grid-template-columns: repeat(3, 1fr); }
  .agp-tile {
    aspect-ratio: 3 / 4;
    border-radius: 10px;
    background: rgba(255,255,255,0.08);
  }
  /* feed */
  .agp-feed { position: relative; height: 100%; }
  .agp-feed-stage {
    position: absolute; inset: 0;
    border-radius: 16px;
    background: linear-gradient(160deg, rgba(255,255,255,0.10), rgba(233,30,99,0.10));
  }
  .agp-feed-rail {
    position: absolute; right: 14px; bottom: 120px;
    display: flex; flex-direction: column; gap: 18px;
  }
  .agp-dot {
    width: 34px; height: 34px; border-radius: 50%;
    background: rgba(255,255,255,0.16);
  }
  .agp-feed-caption { position: absolute; left: 4px; right: 60px; bottom: 70px; }
  /* movie */
  .agp-hero {
    width: 100%; aspect-ratio: 16 / 10;
    border-radius: 14px;
    background: linear-gradient(160deg, rgba(255,255,255,0.10), rgba(233,30,99,0.08));
    margin-bottom: 14px;
  }
  .agp-cta {
    height: 46px; border-radius: 12px;
    background: rgba(233,30,99,0.30);
    margin: 16px 0;
  }
  /* search */
  .agp-searchbar {
    height: 44px; border-radius: 12px;
    background: rgba(255,255,255,0.10);
    margin-bottom: 6px;
  }
`;
