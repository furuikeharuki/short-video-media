import FeedClient from "@/app/FeedClient";

export default function HomePage() {
  // SSRで初期データを渡さない。
  // クライアントマウント後に seed を生成して即座にランダム順で取得する。
  // SSR で取得すると ID 順の最初の一件が一瞬フラッシュするため無効化。
  return (
    <>
      <FeedClient />
      <style>{feedStyle}</style>
    </>
  );
}

const feedStyle = `
  html { background: #000; }
  body { background: #000; overflow: hidden; height: 100dvh; }

  .feed-container {
    position: fixed;
    top: var(--header-h, 52px);
    left: 0; right: 0; bottom: 0;
    overflow: hidden;
  }

  .feed-slide {
    position: absolute;
    inset: 0;
    transition: transform 0.32s cubic-bezier(0.4, 0, 0.2, 1);
    will-change: transform;
  }

  .feed-item {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #000;
  }

  .video-bg { position: absolute; inset: 0; }
  .thumbnail-bg { position: absolute; inset: 0; }
  .thumbnail-img { width: 100%; height: 100%; object-fit: cover; display: block; }

  .info-overlay {
    position: absolute;
    bottom: 0; left: 0; right: 0;
    padding: 0 16px 32px;
    color: #fff;
    z-index: 10;
  }
  .genre-list { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .genre-badge {
    display: inline-block;
    background: rgba(255,255,255,0.15);
    border: 1px solid rgba(255,255,255,0.3);
    backdrop-filter: blur(4px);
    color: #fff; font-size: 11px; font-weight: 600;
    letter-spacing: 0.05em; padding: 3px 10px; border-radius: 999px;
  }
  .item-title {
    font-size: clamp(16px, 4vw, 22px); font-weight: 700; line-height: 1.3;
    margin-bottom: 6px; text-shadow: 0 1px 8px rgba(0,0,0,0.6);
    display: -webkit-box; -webkit-line-clamp: 2;
    -webkit-box-orient: vertical; overflow: hidden;
  }
  .item-actress { font-size: 13px; color: rgba(255,255,255,0.75); margin-bottom: 16px; }
  .cta-buttons { display: flex; gap: 10px; flex-wrap: wrap; }
  .btn-detail, .btn-buy {
    display: inline-block; padding: 12px 22px; border-radius: 10px;
    font-size: 14px; font-weight: 700; text-decoration: none;
    text-align: center; min-height: 44px;
    transition: opacity 0.15s ease, transform 0.15s ease;
  }
  .btn-detail:active, .btn-buy:active { opacity: 0.75; transform: scale(0.97); }
  .btn-detail {
    background: rgba(255,255,255,0.18);
    border: 1px solid rgba(255,255,255,0.4);
    backdrop-filter: blur(8px); color: #fff; flex: 1;
  }
  .btn-buy { background: #e91e63; color: #fff; flex: 1; }
`;
