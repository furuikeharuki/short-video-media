"use client";

import type { RefObject } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";

interface Props {
  src: string;
  preload: "auto" | "metadata";
  containerRef: RefObject<HTMLDivElement>;
  shimmerRef: RefObject<HTMLDivElement>;
  spinnerRef: RefObject<HTMLDivElement>;
  fastBadgeRef: RefObject<HTMLDivElement>;
  overlayRef: RefObject<HTMLDivElement>;
  /** メイン <video> 要素を受け取る ref。useFeedPlayback の videoRef。 */
  videoRef: RefObject<HTMLVideoElement>;
  thumbnailUrl: string;
  thumbnailAlt: string;
  onLoadStart: () => void;
  onLoadedMetadata: () => void;
  onLoadedData: () => void;
  onCanPlay: () => void;
  onSeeked: () => void;
  onError?: (e: Event) => void;
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  onTouchCancel: () => void;
  onMouseDown: () => void;
  onMouseUp: () => void;
  onMouseLeave: () => void;
  onClick: (e: React.MouseEvent) => void;
  /**
   * prefetch buffer から claim した <video> 要素。null のときは通常通り JSX で
   * <video> を新規マウントする。non-null のときは host <div> にこの要素を
   * appendChild して videoRef にもセットする。
   */
  promotedElement?: HTMLVideoElement | null;
  /**
   * 「これから (この commit の layout 効果で) promote が確定する見込み」のフラグ。
   * 初回レンダーで JSX <video> をマウントしてから 1 tick 後に廃棄する無駄を避け、
   * 最初から host だけを描画する。layout effect 経由で `promotedElement` が入る
   * 直前の渋滞対策。
   */
  expectingPromotion?: boolean;
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
  onSeeked,
  onError,
  onTouchStart,
  onTouchEnd,
  onTouchCancel,
  onMouseDown,
  onMouseUp,
  onMouseLeave,
  onClick,
  promotedElement,
  expectingPromotion,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // promotion 時に host に append された <video> 要素を保持。アンマウント時に
  // host から外して破棄するために覚えておく。
  const adoptedRef = useRef<HTMLVideoElement | null>(null);

  useLayoutEffect(() => {
    if (!promotedElement) return;
    const host = hostRef.current;
    if (!host) return;

    // host へ promoted 要素を移植。
    // 既にマウント済みなら何もしない (同じ promoted を使い回すケース)。
    if (adoptedRef.current === promotedElement && promotedElement.parentNode === host) {
      return;
    }
    if (promotedElement.parentNode && promotedElement.parentNode !== host) {
      promotedElement.parentNode.removeChild(promotedElement);
    }
    // active 表示用にスタイルをリセット
    promotedElement.removeAttribute("aria-hidden");
    promotedElement.tabIndex = 0;
    promotedElement.style.position = "";
    promotedElement.style.top = "";
    promotedElement.style.left = "";
    promotedElement.style.width = "";
    promotedElement.style.height = "";
    promotedElement.style.opacity = "0"; // useFeedPlayback が setVideoReady で 1 に
    promotedElement.style.pointerEvents = "";
    promotedElement.style.zIndex = "";
    promotedElement.className = "feed-video";
    promotedElement.muted = true;
    promotedElement.loop = true;
    promotedElement.playsInline = true;
    promotedElement.controls = false;
    promotedElement.preload = preload;
    promotedElement.setAttribute(
      "controlsList",
      "nodownload noremoteplayback nofullscreen noplaybackrate",
    );
    promotedElement.disablePictureInPicture = true;
    // 一部の型定義に無いがブラウザは認識する
    (promotedElement as unknown as { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
    promotedElement.setAttribute("x-webkit-airplay", "deny");
    host.appendChild(promotedElement);
    adoptedRef.current = promotedElement;

    // videoRef を promoted 要素に向ける。
    (videoRef as { current: HTMLVideoElement | null }).current = promotedElement;

    const ls = () => onLoadStart();
    const lm = () => onLoadedMetadata();
    const ld = () => onLoadedData();
    const cp = () => onCanPlay();
    const sk = () => onSeeked();
    const er = (e: Event) => onError?.(e);
    const cm = (e: Event) => e.preventDefault();

    promotedElement.addEventListener("loadstart", ls);
    promotedElement.addEventListener("loadedmetadata", lm);
    promotedElement.addEventListener("loadeddata", ld);
    promotedElement.addEventListener("canplay", cp);
    promotedElement.addEventListener("seeked", sk);
    promotedElement.addEventListener("error", er);
    promotedElement.addEventListener("contextmenu", cm);

    // 既に canplay 到達済みのはずなので、合成イベントとして手動で通知して
    // 親の videoReady を立てる (新規 listener では二度と発火しない可能性あり)。
    if (promotedElement.readyState >= 3) {
      // microtask で送って、host 内 ref 設定や effect 連鎖と競合しないようにする
      queueMicrotask(() => {
        if (adoptedRef.current !== promotedElement) return;
        onCanPlay();
      });
    } else if (promotedElement.readyState >= 2) {
      queueMicrotask(() => {
        if (adoptedRef.current !== promotedElement) return;
        onLoadedData();
      });
    } else if (promotedElement.readyState >= 1) {
      queueMicrotask(() => {
        if (adoptedRef.current !== promotedElement) return;
        onLoadedMetadata();
      });
    }

    return () => {
      promotedElement.removeEventListener("loadstart", ls);
      promotedElement.removeEventListener("loadedmetadata", lm);
      promotedElement.removeEventListener("loadeddata", ld);
      promotedElement.removeEventListener("canplay", cp);
      promotedElement.removeEventListener("seeked", sk);
      promotedElement.removeEventListener("error", er);
      promotedElement.removeEventListener("contextmenu", cm);
      // host からのデタッチと完全破棄。
      try {
        promotedElement.pause();
      } catch {
        /* ignore */
      }
      try {
        promotedElement.removeAttribute("src");
        promotedElement.load();
      } catch {
        /* ignore */
      }
      if (promotedElement.parentNode === host) {
        host.removeChild(promotedElement);
      }
      if (adoptedRef.current === promotedElement) {
        adoptedRef.current = null;
      }
      if ((videoRef as { current: HTMLVideoElement | null }).current === promotedElement) {
        (videoRef as { current: HTMLVideoElement | null }).current = null;
      }
    };
  }, [
    promotedElement,
    preload,
    onLoadStart,
    onLoadedMetadata,
    onLoadedData,
    onCanPlay,
    onSeeked,
    onError,
    videoRef,
  ]);

  // preload 属性の変化 (active になった後など) を促す。
  useEffect(() => {
    if (!promotedElement) return;
    if (promotedElement.preload !== preload) {
      promotedElement.preload = preload;
    }
  }, [promotedElement, preload]);

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

      {promotedElement || expectingPromotion ? (
        // promoted 要素を host にマウントするための入れ物。実 <video> は useEffect で
        // appendChild される。React は host を所有するが <video> は所有しない。
        // expectingPromotion=true のときは promotedElement state が入る直前 commit で
        // 既に host だけを描画しておくことで、JSX <video> をマウント→即破棄する
        // 無駄なネットワーク発火を避ける。
        <div ref={hostRef} className="feed-video-host" style={{ display: "contents" }} />
      ) : (
        <video
          ref={videoRef}
          src={src}
          muted
          loop
          playsInline
          preload={preload}
          onLoadStart={onLoadStart}
          onLoadedMetadata={onLoadedMetadata}
          onLoadedData={onLoadedData}
          onCanPlay={onCanPlay}
          onSeeked={onSeeked}
          onError={(e) => onError?.(e.nativeEvent)}
          onContextMenu={(e) => e.preventDefault()}
          controlsList="nodownload noremoteplayback nofullscreen noplaybackrate"
          disablePictureInPicture
          disableRemotePlayback
          x-webkit-airplay="deny"
          className="feed-video"
          style={{ opacity: 0 }}
        />
      )}

      <div className="overlay-wrap">
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
