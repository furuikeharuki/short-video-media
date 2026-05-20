/**
 * ルートロード画面。
 *
 * ホーム (`/`) など、独自の loading.tsx を持たないルート全般で表示される。
 * 以前はグリッド型のスケルトンを出していたが、ホームでは過剰なため、
 * マイページ等と同じ「スピナー + 読み込み中... のテキスト」だけにする。
 * フィード専用のフルスクリーンスケルトンは `app/feed/loading.tsx` で別途維持。
 */
export default function Loading() {
  return (
    <main className="home-loading-main">
      <div className="home-loading-spinner" aria-hidden="true" />
      <p className="home-loading-text">読み込み中...</p>
      <style>{css}</style>
    </main>
  );
}

const css = `
  .home-loading-main {
    position: fixed;
    top: var(--header-h, 52px);
    left: 0; right: 0;
    bottom: var(--bottom-nav-h, 56px);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: #000;
    color: rgba(255,255,255,0.7);
  }
  .home-loading-spinner {
    width: 36px;
    height: 36px;
    border: 3px solid rgba(255,255,255,0.15);
    border-top-color: #fff;
    border-radius: 50%;
    animation: home-loading-spin 0.8s linear infinite;
  }
  .home-loading-text {
    margin: 0;
    font-size: 14px;
    color: rgba(255,255,255,0.5);
    letter-spacing: 0.02em;
  }
  @keyframes home-loading-spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .home-loading-spinner { animation: none; }
  }
`;
