"use client";

import type { RefObject } from "react";

interface Props {
  src: string;
  preload: "auto" | "metadata";
  containerRef: RefObject<HTMLDivElement>;
  shimmerRef: RefObject<HTMLDivElement>;
  spinnerRef: RefObject<HTMLDivElement>;
  fastBadgeRef: RefObject<HTMLDivElement>;
  overlayRef: RefObject<HTMLDivElement>;
  videoRef: RefObject<HTMLVideoElement>;
  thumbnailUrl: string;
  thumbnailAlt: string;
  onLoadStart: () => void;
  onLoadedMetadata: () => void;
  onLoadedData: () => void;
  onCanPlay: () => void;
  onError?: (e: React.SyntheticEvent<HTMLVideoElement>) => void;
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  onTouchCancel: () => void;
  onMouseDown: () => void;
  onMouseUp: () => void;
  onMouseLeave: () => void;
  onClick: (e: React.MouseEvent) => void;
}

export default function FeedItemVideo({
  src,
  preload,
  containerRef,
  shimmerRef,
  spinnerRef,
  fastBadgeRef,
  overlayRef,
  videoRef,
  thumbnailUrl,
  thumbnailAlt,
  onLoadStart,
  onLoadedMetadata,
  onLoadedData,
  onCanPlay,
  onError,
  onTouchStart,
  onTouchEnd,
  onTouchCancel,
  onMouseDown,
  onMouseUp,
  onMouseLeave,
  onClick,
}: Props) {
  return (
    <div
      ref={containerRef}
      className="video-bg video-bg--interactive"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
    >
      {/*
        ロード中の背景サムネイル (動画と同じ contain ・同じ位置)。
        初期状態で display:none。<video> の loadstart で block にし、
        loadedmetadata で none に戻すことで、プリフェッチ済スライドでスワイプした
        瞬間にサムネが一瞬見えるチラつきを避ける。スピナー自体は overlay-wrap 側に
        独立して置き、再生中のバッファ不足時にも表示できるようにする。
      */}
      <div
        ref={shimmerRef}
        className="shimmer"
        aria-hidden="true"
        style={{ display: "none" }}
      >
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={thumbnailAlt}
            className="shimmer-thumb"
            loading="eager"
            decoding="async"
            draggable={false}
            onContextMenu={(e) => e.preventDefault()}
          />
        ) : null}
      </div>

      <video
        ref={videoRef}
        src={src}
        // poster を指定しておくと、<video> が loadeddata に到達するまで
        // ブラウザがネイティブにサムネ画像を表示してくれる。
        // これにより resolving (thumbnail-bg) → <video> マウント時の
        // 「黒画面+スピナー」が出ず、サムネ+スピナーのまま自然に再生に遷移する。
        poster={thumbnailUrl || undefined}
        muted
        loop
        playsInline
        preload={preload}
        onLoadStart={onLoadStart}
        onLoadedMetadata={onLoadedMetadata}
        onLoadedData={onLoadedData}
        onCanPlay={onCanPlay}
        onError={onError}
        onContextMenu={(e) => e.preventDefault()}
        controlsList="nodownload noremoteplayback nofullscreen noplaybackrate"
        disablePictureInPicture
        disableRemotePlayback
        x-webkit-airplay="deny"
        className="feed-video"
        style={{ opacity: 0, transition: "opacity 0.3s ease" }}
      />

      <div className="overlay-wrap">
        {/*
          ローディングスピナー。一時停止アイコン (.action-overlay) と同じ
          overlay-wrap 内に置くことで中央・モバイルでもボトムバーぶんの
          余白を考慮した同一の位置に表示される。初回ロード中だけでなく、
          再生中の waiting/stalled 時にも表示される。
        */}
        <div
          ref={spinnerRef}
          className="loading-spinner"
          aria-hidden="true"
          style={{ display: "flex" }}
        />
        <div
          ref={overlayRef}
          className="action-overlay"
          aria-hidden="true"
          style={{ display: "none" }}
        >
          <span className="action-icon action-icon--pause" style={{ display: "none" }}>
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
              <rect x="12" y="8" width="10" height="32" rx="2" fill="white"/>
              <rect x="26" y="8" width="10" height="32" rx="2" fill="white"/>
            </svg>
          </span>
          <span className="action-icon action-icon--play" style={{ display: "none" }}>
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
              <path d="M14 8L40 24L14 40V8Z" fill="white"/>
            </svg>
          </span>
        </div>
      </div>

      <div ref={fastBadgeRef} className="fast-badge" aria-hidden="true" style={{ display: "none" }}>2×</div>
    </div>
  );
}
