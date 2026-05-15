"use client";

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

export default function FeedItemSideActions({
  item,
  isMuted,
  isBookmarked,
  onToggleMute,
  onToggleBookmark,
  onShare,
  onDetail,
}: Props) {
  return (
    <div
      className="side-actions"
      onClick={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      {/* ミュート */}
      <button
        className="side-btn"
        aria-label={isMuted ? "音声ON" : "ミュート"}
        onTouchEnd={onToggleMute}
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

      {/* ブックマーク */}
      <button
        className={`side-btn${isBookmarked ? " side-btn--active" : ""}`}
        aria-label="ブックマーク"
        onTouchEnd={(e) => { e.stopPropagation(); onToggleBookmark(e); }}
        onClick={(e) => { e.stopPropagation(); onToggleBookmark(e); }}
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

      {/* 共有 */}
      <button
        className="side-btn"
        aria-label="共有"
        onTouchEnd={onShare}
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

      {/* 詳細 */}
      <button
        className="side-btn"
        aria-label="詳細を見る"
        onTouchEnd={onDetail}
        onClick={onDetail}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span className="side-btn-label">詳細</span>
      </button>

      {/* 購入 */}
      <a
        href={item.affiliate_url}
        target="_blank"
        rel="noopener noreferrer"
        className="side-btn side-btn--buy"
        aria-label="購入する"
        onClick={(e) => e.stopPropagation()}
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
