/**
 * ルートロード画面。
 *
 * ホーム (`/`) など、独自の loading.tsx を持たないルート全般で表示される。
 * 以前はフィードと同じフルスクリーンのスケルトンを出していたが、
 * ホームでは過剰だったため検索一覧と同じトーンのグリッド・シマー型スケルトンに統一する。
 * フィード専用のフルスクリーンスケルトンは `app/feed/loading.tsx` に分離してある。
 */
export default function Loading() {
  const skeletons = Array.from({ length: 18 });

  return (
    <main style={mainStyle}>
      <div style={metaStyle} />
      <div className="home-loading-grid">
        {skeletons.map((_, i) => (
          <div key={i} className="skeleton-card">
            <div className="skeleton-inner" />
          </div>
        ))}
      </div>
      <style>{css}</style>
    </main>
  );
}

const mainStyle: React.CSSProperties = {
  position: "fixed",
  top: "var(--header-h, 52px)" as unknown as string,
  left: 0,
  right: 0,
  bottom: "var(--bottom-nav-h, 56px)" as unknown as string,
  overflowY: "auto",
  background: "#0a0a0a",
};

const metaStyle: React.CSSProperties = {
  height: "36px",
};

const css = `
  .home-loading-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    padding: 8px;
  }
  @media (min-width: 640px)  { .home-loading-grid { grid-template-columns: repeat(5, 1fr); } }
  @media (min-width: 1024px) {
    .home-loading-grid {
      grid-template-columns: repeat(7, 1fr);
      max-width: 1200px;
      margin: 0 auto;
    }
  }
  .skeleton-card {
    position: relative;
    aspect-ratio: 9 / 13;
    background: #1a1a1a;
    overflow: hidden;
    border-radius: 10px;
  }
  .skeleton-inner {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      105deg,
      transparent 40%,
      rgba(255,255,255,0.07) 50%,
      transparent 60%
    );
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  @keyframes shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .skeleton-inner { animation: none !important; }
  }
`;
