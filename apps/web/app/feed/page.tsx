import type { Metadata } from "next";
import FeedClient from "@/app/FeedClient";
import ExoClickBanner, {
  EXOCLICK_BANNER_HEIGHT,
} from "@/components/ads/ExoClickBanner";

export const metadata: Metadata = {
  title: "ショートフィード",
  description: "AVをショート動画で試し見。気に入ったらFANZAでそのまま購入できるアダルト動画メディア。",
};

const FEED_BANNER_HEIGHT = EXOCLICK_BANNER_HEIGHT;

export default function FeedPage() {
  const adsEnabled = process.env.NEXT_PUBLIC_ADS_ENABLED === "true";

  return (
    <>
      {adsEnabled && (
        <div
          className="feed-ad-slot"
          style={{ height: FEED_BANNER_HEIGHT }}
        >
          <ExoClickBanner minHeight={FEED_BANNER_HEIGHT} />
        </div>
      )}
      <FeedClient />
      <style>{feedStyle(adsEnabled ? FEED_BANNER_HEIGHT : 0)}</style>
    </>
  );
}

const feedStyle = (bannerH: number) => `
  html { background: #000; }
  body { background: #000; overflow: hidden; height: 100dvh; }

  .feed-ad-slot {
    position: fixed;
    top: var(--header-h, 52px);
    left: 0; right: 0;
    z-index: 5;
    background: #000;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .feed-container {
    position: fixed;
    top: calc(var(--header-h, 52px) + ${bannerH}px);
    left: 0; right: 0;
    bottom: var(--bottom-nav-h, 56px);
    height: auto;
    overflow: hidden;
  }

  .feed-slide {
    position: absolute;
    inset: 0;
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
  /* .thumbnail-bg / .thumbnail-img のスタイルは feedItemStyle.ts で一元管理 */
`;
