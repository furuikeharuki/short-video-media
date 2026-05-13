import FeedClient from "@/app/FeedClient";

export default function HomePage() {
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
    background: #000;
  }

  /* feed-slide は inset:0 で絶対配置しつつ、
     内部を flex 中央寄せにすることで feed-item が中央に来る */
  .feed-slide {
    position: absolute;
    inset: 0;
    display: flex;
    justify-content: center;
    align-items: stretch;
    transition: transform 0.32s cubic-bezier(0.4, 0, 0.2, 1);
    will-change: transform;
  }

  /* スマホ: 全幅全高 */
  .feed-item {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #111;
  }

  /* PC: 390px 固定幅 + 角丸 + 影で TikTok PC風 */
  @media (min-width: 600px) {
    .feed-item {
      width: 390px;
      height: calc(100% - 24px);
      margin: 12px 0;
      border-radius: 16px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.8);
      flex-shrink: 0;
    }
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
    background: linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.28) 60%, transparent 100%);
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
    font-size: clamp(15px, 3.5vw, 20px); font-weight: 700; line-height: 1.3;
    margin-bottom: 6px; text-shadow: 0 1px 8px rgba(0,0,0,0.6);
    display: -webkit-box; -webkit-line-clamp: 2;
    -webkit-box-orient: vertical; overflow: hidden;
  }
  @media (min-width: 600px) {
    .item-title { font-size: 17px; }
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
