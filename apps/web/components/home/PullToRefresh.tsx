"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  children: React.ReactNode;
  /** スクロール領域のクラス名 (内部の overflow-y:auto コンテナ) */
  className?: string;
  /** リフレッシュ発火する閾値 (px) */
  threshold?: number;
};

/**
 * 一番上 (scrollTop=0) のときに下方向へ引っ張ると、
 * インジケータが表示されて、しきい値を超えて指を離すと router.refresh() でリロードする。
 *
 * /home は Server Component なので、router.refresh() で最新の getHome() 結果が再取得される。
 */
export default function PullToRefresh({
  children,
  className = "",
  threshold = 70,
}: Props) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef<number | null>(null);
  const pullingRef = useRef(false);

  const [pullPx, setPullPx] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      if (isRefreshing) return;
      // スクロール位置が一番上のときのみ、引っ張り開始の起点を記録
      if (el.scrollTop > 0) {
        startYRef.current = null;
        return;
      }
      startYRef.current = e.touches[0].clientY;
      pullingRef.current = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (isRefreshing) return;
      if (startYRef.current == null) return;
      const dy = e.touches[0].clientY - startYRef.current;
      if (dy <= 0) {
        // 上方向のスワイプはネイティブスクロールに任せる
        setPullPx(0);
        pullingRef.current = false;
        return;
      }
      // 下に引っ張ろうとしている。先頭にいるはずなのでネイティブスクロールを抑制
      if (el.scrollTop <= 0) {
        e.preventDefault();
        pullingRef.current = true;
        // 抵抗感を出すため減衰
        setPullPx(Math.min(dy * 0.5, threshold * 1.6));
      }
    };

    const onTouchEnd = async () => {
      if (isRefreshing) return;
      if (!pullingRef.current) {
        setPullPx(0);
        return;
      }
      pullingRef.current = false;
      if (pullPx >= threshold) {
        setIsRefreshing(true);
        setPullPx(threshold * 0.7);
        try {
          router.refresh();
        } finally {
          // refresh() は即時返るので、見た目用に少し残してから戻す
          setTimeout(() => {
            setIsRefreshing(false);
            setPullPx(0);
          }, 700);
        }
      } else {
        setPullPx(0);
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [isRefreshing, pullPx, threshold, router]);

  const reached = pullPx >= threshold;

  return (
    <div ref={containerRef} className={className}>
      <div
        className="ptr-indicator"
        style={{
          height: `${pullPx}px`,
          opacity: pullPx > 0 ? 1 : 0,
        }}
        aria-hidden="true"
      >
        <div className={`ptr-spinner ${isRefreshing ? "ptr-spinning" : ""}`}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 12a8 8 0 0 1 14-5.3"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
            <path
              d="M18 3v4h-4"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <span className="ptr-label">
          {isRefreshing
            ? "更新中..."
            : reached
            ? "離して更新"
            : "下に引いて更新"}
        </span>
      </div>

      <div
        style={{
          transform: pullPx > 0 ? `translateY(0)` : undefined,
          transition: isRefreshing ? "transform 0.2s" : undefined,
        }}
      >
        {children}
      </div>

      <style>{styles}</style>
    </div>
  );
}

const styles = `
  .ptr-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    overflow: hidden;
    color: rgba(255,255,255,0.65);
    font-size: 12px;
    transition: opacity 0.15s;
  }
  .ptr-spinner {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .ptr-spinning {
    animation: ptr-spin 0.8s linear infinite;
  }
  @keyframes ptr-spin { to { transform: rotate(360deg); } }
`;
