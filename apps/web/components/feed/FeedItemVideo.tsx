"use client";

import type { RefObject } from "react";

interface HighProbeProps {
  /**
   * 高画質プローブ <video> の src。null のときはプローブをマウントしない。
   * メイン <video> がまだ低画質を再生しているうちに、この hidden <video> が
   * canplay に到達したらメイン側 src を高画質に差し替える。
   */
  src: string | null;
  onCanPlay: () => void;
  onError: () => void;
}

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
  /** 低画質ファースト戦略用の hidden probe <video> 設定。null でプローブ無効。 */
  highProbe?: HighProbeProps;
  onLoadStart: () => void;
  onLoadedMetadata: () => void;
  onLoadedData: () => void;
  onCanPlay: () => void;
  /**
   * <video> がシークを完了したとき。
   * プロ女優作品で loadedmetadata 後に currentTime=5 にシークした際、
   * そのシーク先フレームがデコードされたところで opacity:1 にして
   * 黒画面を最小限にするために使う。
   */
  onSeeked: () => void;
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
  highProbe,
  onLoadStart,
  onLoadedMetadata,
  onLoadedData,
  onCanPlay,
  onSeeked,
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
        // 注: poster は意図的に指定しない。
        // <video poster> は loadeddata に到達した後もブラウザ実装によっては表示が残り、
        // isAdjacent (隣接スライドで preload 済) の <video> でスワイプ中央到達時に
        // poster (= サムネ画像) が一瞬見えるチラつきの原因になっていた。
        // resolve 必要時のサムネ表示は <FeedItem> の thumbnail-bg 経路 (showVideo=false の間)
        // で実現する。<video> 自体は opacity:0 でマウント → loadeddata で opacity:1 にし、
        // それまでは黒画面 (.video-bg の background:#000) を見せる。
        muted
        loop
        playsInline
        preload={preload}
        onLoadStart={onLoadStart}
        onLoadedMetadata={onLoadedMetadata}
        onLoadedData={onLoadedData}
        onCanPlay={onCanPlay}
        onSeeked={onSeeked}
        onError={onError}
        onContextMenu={(e) => e.preventDefault()}
        controlsList="nodownload noremoteplayback nofullscreen noplaybackrate"
        disablePictureInPicture
        disableRemotePlayback
        x-webkit-airplay="deny"
        className="feed-video"
        // opacity の transition は付けない。loadeddata / seeked でフレームが出た瞬間に
        // setVideoReady(true) で opacity:1 に切り替えるため、フェードで遅らせると
        // 黒画面の時間が長く見えてしまう。
        style={{ opacity: 0 }}
      />

      {/*
        低画質ファースト戦略用の hidden プローブ <video>。
        - 中央スライドでメインが低画質を再生中、裏でこの <video> が高画質をプリロードする。
        - canplay 到達でメイン <video> の src を高画質に差し替える (useLowFirstVideoSrc 側で実施)。
        - lowSrc === highSrc / 旧 API / 隣接スライド / 高速スワイプ中 は src=null でアンマウント。
        - display:none ではなく visibility:hidden + 1px サイズで配置: 一部ブラウザは display:none の
          <video> をネットワーク経由で全くロードしないため、確実に preload を発火させたい。
        - muted / playsInline / preload="auto" で iOS でもサウンドポリシーに引っかからずロードを進める。
      */}
      {highProbe?.src ? (
        <video
          key={highProbe.src}
          src={highProbe.src}
          muted
          playsInline
          preload="auto"
          // 再生はしない (autoPlay 無し)。canplay の発火だけが目的。
          onCanPlay={highProbe.onCanPlay}
          onError={highProbe.onError}
          aria-hidden="true"
          tabIndex={-1}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: "none",
            // visibility:hidden ではなく opacity:0 を使う: visibility:hidden だと
            // ブラウザによっては <video> 自体を扱わず、ロードを中断するケースがある。
            left: -9999,
            top: -9999,
          }}
        />
      ) : null}

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
