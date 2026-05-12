import { getFeed } from "@/lib/api/feed";
import FeedItem from "@/components/FeedItem";

export default async function HomePage() {
  const feed = await getFeed();

  if (feed.items.length === 0) {
    return (
      <main className="empty-state">
        <div className="empty-inner">
          <p className="empty-icon">🎬</p>
          <h2>まだ作品がありません</h2>
          <p>しばらくしてから再度ご確認ください。</p>
        </div>
        <style>{emptyStyle}</style>
      </main>
    );
  }

  return (
    <>
      <main className="feed-container">
        {feed.items.map((item, index) => (
          <FeedItem
            key={item.id}
            item={item}
            isFirst={index === 0}
          />
        ))}
      </main>

      <style>{feedStyle}</style>
    </>
  );
}

const feedStyle = `
  *,
  *::before,
  *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  html,
  body {
    background: #000;
    overflow: hidden;
  }

  /* ─── フィードコンテナ ───────────────────── */
  .feed-container {
    height: 100dvh;
    overflow-y: scroll;
    scroll-snap-type: y mandatory;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .feed-container::-webkit-scrollbar {
    display: none;
  }

  /* ─── 各アイテム ────────────────────── */
  .feed-item {
    position: relative;
    width: 100%;
    height: 100dvh;
    scroll-snap-align: start;
    scroll-snap-stop: always;
    overflow: hidden;
    background: #111;
  }

  /* ─── 動画プレイヤー ───────────────── */
  .video-bg {
    position: absolute;
    inset: 0;
  }
  .video-player {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /* ─── サムネイル（動画なしのフォールバック） ── */
  .thumbnail-bg {
    position: absolute;
    inset: 0;
  }
  .thumbnail-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /* ─── オーバーレイ共通 ──────────────── */
  .thumbnail-overlay {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      to bottom,
      transparent 35%,
      rgba(0, 0, 0, 0.3) 55%,
      rgba(0, 0, 0, 0.85) 80%,
      rgba(0, 0, 0, 0.95) 100%
    );
  }

  /* ─── 下部オーバーレイ ──────────────── */
  .info-overlay {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 0 16px 32px;
    color: #fff;
    z-index: 10;
  }

  /* ジャンルバッジ */
  .genre-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
  }
  .genre-badge {
    display: inline-block;
    background: rgba(255, 255, 255, 0.15);
    border: 1px solid rgba(255, 255, 255, 0.3);
    backdrop-filter: blur(4px);
    color: #fff;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.05em;
    padding: 3px 10px;
    border-radius: 999px;
  }

  /* タイトル */
  .item-title {
    font-size: clamp(16px, 4vw, 22px);
    font-weight: 700;
    line-height: 1.3;
    margin-bottom: 6px;
    text-shadow: 0 1px 8px rgba(0,0,0,0.6);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* 女優名 */
  .item-actress {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.75);
    margin-bottom: 16px;
  }

  /* CTAボタン */
  .cta-buttons {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .btn-detail,
  .btn-buy {
    display: inline-block;
    padding: 12px 22px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 700;
    text-decoration: none;
    text-align: center;
    min-height: 44px;
    transition: opacity 0.15s ease, transform 0.15s ease;
  }
  .btn-detail:active,
  .btn-buy:active {
    opacity: 0.75;
    transform: scale(0.97);
  }
  .btn-detail {
    background: rgba(255, 255, 255, 0.18);
    border: 1px solid rgba(255, 255, 255, 0.4);
    backdrop-filter: blur(8px);
    color: #fff;
    flex: 1;
  }
  .btn-buy {
    background: #e91e63;
    color: #fff;
    flex: 1;
  }

  /* スクロールヒント */
  .scroll-hint {
    position: absolute;
    bottom: 140px;
    right: 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    color: rgba(255, 255, 255, 0.5);
    font-size: 11px;
    z-index: 10;
    animation: bounce 2s ease-in-out infinite;
  }
  .scroll-arrow {
    font-size: 18px;
  }
  @keyframes bounce {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(6px); }
  }

  @media (prefers-reduced-motion: reduce) {
    .scroll-hint { animation: none; }
  }
`;

const emptyStyle = `
  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100dvh;
    background: #0a0a0a;
    color: #fff;
  }
  .empty-inner {
    text-align: center;
    padding: 24px;
  }
  .empty-icon {
    font-size: 48px;
    margin-bottom: 16px;
  }
  .empty-inner h2 {
    font-size: 20px;
    margin-bottom: 8px;
  }
  .empty-inner p {
    color: rgba(255,255,255,0.5);
    font-size: 14px;
  }
`;
