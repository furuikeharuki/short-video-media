"use client";

import { useEffect, useRef } from "react";
import { serveAd } from "@/components/ads/AdScriptLoader";
import { AD_ZONES } from "@/lib/ads/config";

interface Props {
  adIndex: number;
  isActive: boolean;
}

/**
 * フィード内広告スライド。
 * FeedViewer のスライドと全全同じサイズを占有し、
 * ネイティブ広告 (zoneid: 5930078) を表示する。
 *
 * 公式タグ構造（ユーザー指定）:
 *   <script async src="https://a.magsrv.com/ad-provider.js"></script>
 *   <ins class="eas6a97888e20" data-zoneid="5930078"></ins>
 *   <script>(AdProvider=[]).push({"serve":{}})</script>
 */
export default function FeedAdSlide({ adIndex, isActive }: Props) {
  const zone = AD_ZONES["feedNative"];
  const insRef = useRef<HTMLElement | null>(null);
  const servedRef = useRef(false);

  useEffect(() => {
    if (!isActive) return;
    if (servedRef.current) return;
    servedRef.current = true;
    serveAd(zone.provider);
  }, [isActive, zone.provider]);

  return (
    <div className="feed-ad-slide">
      <div className="feed-ad-inner">
        <span className="feed-ad-label">広告</span>
        <ins
          ref={insRef as React.RefObject<HTMLModElement>}
          className={zone.insClass}
          data-zoneid={zone.zoneId}
        />
      </div>
      <style>{css}</style>
    </div>
  );
}

const css = `
  .feed-ad-slide {
    position: absolute;
    inset: 0;
    background: #000;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .feed-ad-inner {
    position: relative;
    width: 100%;
    max-width: 480px;
    padding: 16px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .feed-ad-label {
    font-size: 11px;
    color: rgba(255,255,255,0.35);
    letter-spacing: 0.05em;
    text-transform: uppercase;
    align-self: flex-start;
  }
  .feed-ad-inner ins {
    display: block;
    width: 100%;
  }
`;
