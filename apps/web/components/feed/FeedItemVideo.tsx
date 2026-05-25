"use client";

import type { RefObject } from "react";

interface HighProbeHandlers {
  onCanPlay: () => void;
  onPlaying: () => void;
  onLoadedMetadata: () => void;
  onError: () => void;
}

interface HighProbeProps {
  /**
   * 高画質 <video> の src。null のときはマウントしない (= スワップ不要 or 抑制)。
   * 中央スライドで low 再生中に裏で muted 再生される hidden <video>。
   * `playing` 到達 + currentTime 同期完了で useLowFirstVideoSrc が opacity を入れ替える。
   */
  src: string | null;
  /** true のときに高画質 <video> を可視 (opacity:1) にし、low の opacity を 0 にする。 */
  show: boolean;
  /** 高画質 <video> 要素を受け取る React ref callback。 */
  callbackRef: (el: HTMLVideoElement | null) => void;
  handlers: HighProbeHandlers;
}

interface Props {
  src: string;
  preload: "auto" | "metadata";
  containerRef: RefObject<HTMLDivElement>;
  shimmerRef: RefObject<HTMLDivElement>;
  spinnerRef: RefObject<HTMLDivElement>;
  fastBadgeRef: RefObject<HTMLDivElement>;
  overlayRef: RefObject<HTMLDivElement>;
  /**
   * メイン (low) <video> 要素を受け取る React ref callback。useLowFirstVideoSrc が
   * 内部的に保持しつつ、親 useFeedPlayback の videoRef.current にも同期する。
   */
  lowVideoCallbackRef: (el: HTMLVideoElement | null) => void;
  thumbnailUrl: string;
  thumbnailAlt: string;
  /** 低画質ファースト戦略用の hidden high <video> 設定。 */
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
  lowVideoCallbackRef,
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
        ref={lowVideoCallbackRef}
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
        // 高画質スワップ完了時の low → opacity:0 は useLowFirstVideoSrc が
        // imperative に lowEl.style.opacity = "0" で書き換える (React style にすると
        // useFeedPlayback の opacity:1 直接代入と競合するため、初期値のみ React で指定)。
        style={{ opacity: 0 }}
      />

      {/*
        高画質 <video> (dual-video 版)。
        - 中央スライドで low が再生中、裏で full-size の hidden <video> として muted で
          同時再生する。
        - `playing` イベント到達 + currentTime 同期完了で useLowFirstVideoSrc が
          opacity を 0 → 1 に切り替え、同時に low を pause + opacity:0 にする (crossfade)。
        - これにより `<video src>` の差し替えに伴う `emptied → loadstart → loadedmetadata
          → seek → playing` の停止フェーズが発生せず、ユーザーから見て「停止しないで画質が向上する」遷移になる。
        - lowSrc === highSrc / 旧 API / 隣接スライド / 高速スワイプ中 は src=null でアンマウント。
        - autoPlay は付けない。useLowFirstVideoSrc 側で canplay/loadedmetadata 後に
          play() を呼ぶ。iOS の autoplay 制約は muted + playsInline で満たしている。
      */}
      {highProbe?.src ? (
        <video
          key={highProbe.src}
          ref={highProbe.callbackRef}
          src={highProbe.src}
          muted
          loop
          playsInline
          preload="auto"
          onCanPlay={highProbe.handlers.onCanPlay}
          onPlaying={highProbe.handlers.onPlaying}
          onLoadedMetadata={highProbe.handlers.onLoadedMetadata}
          onError={highProbe.handlers.onError}
          onContextMenu={(e) => e.preventDefault()}
          controlsList="nodownload noremoteplayback nofullscreen noplaybackrate"
          disablePictureInPicture
          disableRemotePlayback
          x-webkit-airplay="deny"
          className="feed-video feed-video--high"
          aria-hidden={!highProbe.show}
          style={{
            // crossfade 完了までは完全に hidden (opacity:0)。layout は low と同じ
            // .feed-video スタイル + 同じ親の絶対配置になる前提なので、サイズ・位置は揃う。
            opacity: highProbe.show ? 1 : 0,
            // ポインタイベントは常に low (= 操作対象) に通す。show=true でも
            // useFeedPlayback はコンテナ上の onClick / onTouchStart で受けるため
            // high <video> 自体はクリックを奪わない。
            pointerEvents: "none",
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
