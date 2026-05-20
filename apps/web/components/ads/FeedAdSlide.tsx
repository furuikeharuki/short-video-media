"use client";

import AdSlot from "@/components/ads/AdSlot";

interface Props {
  adIndex: number;
  isActive: boolean;
}

/**
 * フィード内広告スライド。
 * 黒背景・全画面の中央に 300x250 のモバイルバナーを表示する。
 * Recommendation Widget はレイアウトを壊すため使わない。
 */
export default function FeedAdSlide({ adIndex }: Props) {
  return (
    <div className="feed-ad-slide">
      <AdSlot
        zone="mobileBanner300x250"
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
`;
