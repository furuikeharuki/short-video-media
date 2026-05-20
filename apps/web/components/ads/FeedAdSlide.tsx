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
  /* 広告ラッパーを画面幅いっぱいに広げる */
  .feed-ad-slide .ad-slot {
    width: 100% !important;
    max-width: 100% !important;
    padding: 0;
    box-sizing: border-box;
  }
  /* ExoClick Recommendation Widget は ins の中に <div>/<a> を入れ子で生成し、
     内部 wrapper にインライン style で固定 px 幅を当てるため、ins 直下の
     widget root と入れ子全要素の max-width / width を強制する。 */
  .feed-ad-slide .ad-slot ins {
    display: block !important;
    width: 100% !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
  }
  .feed-ad-slide .ad-slot ins * {
    max-width: 100% !important;
    box-sizing: border-box !important;
  }
  .feed-ad-slide .ad-slot ins > * {
    width: 100% !important;
    max-width: 100% !important;
  }
  .feed-ad-slide .ad-slot ins iframe,
  .feed-ad-slide .ad-slot ins img,
  .feed-ad-slide .ad-slot ins picture,
  .feed-ad-slide .ad-slot ins video {
    width: 100% !important;
    max-width: 100% !important;
    height: auto !important;
  }
  @media (min-width: 768px) {
    .feed-ad-slide .ad-slot,
    .feed-ad-slide .ad-slot ins,
    .feed-ad-slide .ad-slot ins > * {
      max-width: 480px !important;
    }
  }
`;
