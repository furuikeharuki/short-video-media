"use client";

import { useRef } from "react";

import { trackEvent } from "@/lib/analytics/analytics";
import type { MovieCard } from "@/lib/api/feed";

interface Props {
  item: MovieCard;
  isMuted: boolean;
  isBookmarked: boolean;
  onToggleMute: (e: React.MouseEvent | React.TouchEvent) => void;
  onToggleBookmark: (e: React.MouseEvent | React.TouchEvent) => void;
  onShare: (e: React.MouseEvent | React.TouchEvent) => void;
  onDetail: (e: React.MouseEvent | React.TouchEvent) => void;
}

// touchstart からの移動距離がこの値 (px) を超えたら「スワイプ」とみなしてタップ扱いにしない。
// 縦スクロール (フィードのスワイプ) と横スワイプを両方拾うため Math.hypot で評価する。
const TAP_MOVE_THRESHOLD_PX = 10;
// touchstart からの経過時間がこの値 (ms) を超えても、移動距離次第ではタップ扱いを諦める。
// ユーザーが指を置いてから長時間 (長押し / 迷い) はタップ判定の信頼性が下がるため。
const TAP_DURATION_THRESHOLD_MS = 500;

/**
 * フィード右側のアクションボタン群で、スワイプ操作を誤ってタップ判定しないようにする hook。
 *
 * 問題:
 *   - これまでは onTouchEnd={handler} で常にタップ扱いになっていたため、
 *     ユーザーが「ボタンの上を指でなぞって縦スクロール」した結果指を離した瞬間に
 *     ボタンが発火してしまい、意図せずブックマーク / ミュート / 詳細モーダルが開く現象があった。
 *
 * 解決:
 *   - touchstart の座標と時刻を記録。
 *   - touchend の時点で「移動距離が閾値以下」かつ「経過時間が閾値以下」のときだけ handler を発火。
 *   - スワイプ判定のときは onTouchEnd で preventDefault しないので click も走らないが、
 *     念のため touchend で stopPropagation のみ実施。
 */
function useTapGuard(handler: (e: React.TouchEvent) => void) {
  const startRef = useRef<{ x: number; y: number; t: number } | null>(null);

  const onTouchStart = (e: React.TouchEvent) => {
    // フィード側に touch イベントが伝わって縦スクロールが起きなくなるのを避けるため、
    // stopPropagation はしない。座標だけ覚えておく。
    const touch = e.touches[0];
    if (!touch) return;
    startRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      t: Date.now(),
    };
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const start = startRef.current;
    startRef.current = null;
    if (!start) return;
    const touch = e.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const distance = Math.hypot(dx, dy);
    const elapsed = Date.now() - start.t;
    if (
      distance > TAP_MOVE_THRESHOLD_PX ||
      elapsed > TAP_DURATION_THRESHOLD_MS
    ) {
      // スワイプ / 長押し相当 → タップ扱いしない。フィード本体側のスクロール処理に任せる。
      return;
    }
    // 純粋なタップ。click の二重発火を抑えつつ handler を発火。
    e.stopPropagation();
    e.preventDefault();
    handler(e);
  };

  return { onTouchStart, onTouchEnd };
}

export default function FeedItemSideActions({
  item,
  isMuted,
  isBookmarked,
  onToggleMute,
  onToggleBookmark,
  onShare,
  onDetail,
}: Props) {
  const muteTouch = useTapGuard(onToggleMute);
  const bookmarkTouch = useTapGuard(onToggleBookmark);
  const shareTouch = useTapGuard(onShare);
  const detailTouch = useTapGuard(onDetail);
  // 購入リンク用: <a> のデフォルト navigation を タップのときだけ走らせる。
  // スワイプと判定したら preventDefault して遷移を抑える。
  const buyStartRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const buyOnTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    buyStartRef.current = { x: touch.clientX, y: touch.clientY, t: Date.now() };
  };
  const buyOnTouchEnd = (e: React.TouchEvent) => {
    const start = buyStartRef.current;
    buyStartRef.current = null;
    if (!start) return;
    const touch = e.changedTouches[0];
    if (!touch) return;
    const distance = Math.hypot(
      touch.clientX - start.x,
      touch.clientY - start.y,
    );
    const elapsed = Date.now() - start.t;
    if (
      distance > TAP_MOVE_THRESHOLD_PX ||
      elapsed > TAP_DURATION_THRESHOLD_MS
    ) {
      // スワイプと判定 → navigation を抑止。フィード本体のスクロールに任せる。
      e.preventDefault();
    }
    // タップのケースは preventDefault しない → <a> のデフォルト click が走る。
  };

  return (
    <div
      className="side-actions"
      onClick={(e) => e.stopPropagation()}
      // 親 div では touchstart の伝播を止めない。スワイプを拾えるようにするため。
      // (各ボタンの useTapGuard 側で touchstart 位置を記録して判定する)
    >
      <button
        className="side-btn"
        aria-label={isMuted ? "音声ON" : "ミュート"}
        onTouchStart={muteTouch.onTouchStart}
        onTouchEnd={muteTouch.onTouchEnd}
        onClick={onToggleMute}
      >
        {isMuted ? (
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path d="M11 5L6 9H2v6h4l5 4V5z" fill="white"/>
            <line x1="23" y1="9" x2="17" y2="15" stroke="white" strokeWidth="2.2" strokeLinecap="round"/>
            <line x1="17" y1="9" x2="23" y2="15" stroke="white" strokeWidth="2.2" strokeLinecap="round"/>
          </svg>
        ) : (
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path d="M11 5L6 9H2v6h4l5 4V5z" fill="white"/>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" stroke="white" strokeWidth="2" strokeLinecap="round"/>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" stroke="white" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        )}
        <span className="side-btn-label">{isMuted ? "音声OFF" : "音声ON"}</span>
      </button>

      <button
        className={`side-btn${isBookmarked ? " side-btn--active" : ""}`}
        aria-label="ブックマーク"
        onTouchStart={bookmarkTouch.onTouchStart}
        onTouchEnd={bookmarkTouch.onTouchEnd}
        onClick={(e) => {
          e.stopPropagation();
          onToggleBookmark(e);
        }}
      >
        <svg
          width="26" height="26" viewBox="0 0 24 24"
          fill={isBookmarked ? "white" : "none"}
          stroke="white" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
        </svg>
        <span className="side-btn-label">保存</span>
      </button>

      <button
        className="side-btn"
        aria-label="共有"
        onTouchStart={shareTouch.onTouchStart}
        onTouchEnd={shareTouch.onTouchEnd}
        onClick={onShare}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="18" cy="5" r="3"/>
          <circle cx="6" cy="12" r="3"/>
          <circle cx="18" cy="19" r="3"/>
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
        </svg>
        <span className="side-btn-label">共有</span>
      </button>

      <button
        className="side-btn"
        aria-label="詳細を見る"
        onTouchStart={detailTouch.onTouchStart}
        onTouchEnd={detailTouch.onTouchEnd}
        onClick={onDetail}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span className="side-btn-label">詳細</span>
      </button>

      <a
        href={item.affiliate_url || "#"}
        target="_blank"
        // FANZA アフィリエイト遷移なので sponsored を付ける (Google ガイドライン)。
        rel="noopener noreferrer sponsored"
        className="side-btn side-btn--buy"
        aria-label="購入する"
        aria-disabled={item.affiliate_url ? undefined : true}
        onClick={(e) => {
          e.stopPropagation();
          // affiliate_url が空のレコード (データ欠落) は不本意な同一ページ遷移を防ぐ
          if (!item.affiliate_url) {
            e.preventDefault();
            return;
          }
          // 人気女優ランキングは Event.slug を Movie に JOIN して集計するので、
          // 必ず slug を渡すこと (未指定だと集計対象から漏れる)。
          void trackEvent("affiliate_click", {
            slug: item.slug,
            title: item.title,
            affiliate_url: item.affiliate_url,
          });
        }}
        onTouchStart={buyOnTouchStart}
        onTouchEnd={buyOnTouchEnd}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="9" cy="21" r="1"/>
          <circle cx="20" cy="21" r="1"/>
          <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
        </svg>
        <span className="side-btn-label">購入</span>
      </a>
    </div>
  );
}
