"use client";

import AdSlot from "@/components/ads/AdSlot";

interface Props {
  adIndex: number;
  isActive: boolean;
}

/**
 * フィード内広告スライド。
 * 黒背景・全画面で AdSlot(feedNative) を表示する。
 * AdSlot の IntersectionObserver / MutationObserver をそのまま活用する。
 */
export default function FeedAdSlide({ adIndex }: Props) {
  return (
    <div className="feed-ad-slide">
      <AdSlot
        zone="feedNative"
        context={`feed-ad-${adIndex}`}
        label="広告"
        resetOnMount
      />
      <style>{css}</style>
    </div>
  );
}

const css = `
  .feed-ad-slide {
    position: absolute;
    inset: 0;
    background: #111;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .feed-ad-slide .ad-slot {
    width: 100% !important;
    max-width: 480px;
    padding: 0 16px;
    box-sizing: border-box;
  }
`;
