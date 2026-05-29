"use client";

import type { RefObject } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";

import { retainActiveElementToPool } from "@/lib/videoHandoff";

interface Props {
  /**
   * 作品 slug。promoted 要素を unmount 時に pool へ retain する際のキーに使う。
   */
  slug: string;
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
  /**
   * `playing` event handler。再生が実際に進み始めた瞬間 (`paused=false` + フレーム前進)
   * に発火する。canplay や loadeddata が握りつぶされたまま autoplay が resolved する
   * 経路 (promote 後の seek で rs が一旦 1 に落ちて、その後 play() promise だけが
   * resolve するケース) でも、ここで spinner / thumbnail-cover を確実に外すために使う。
   */
  onPlaying?: () => void;
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
  slug,
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
  onPlaying,
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
    const pl = () => onPlaying?.();
    const er = (e: Event) => onError?.(e);
    const cm = (e: Event) => e.preventDefault();

    promotedElement.addEventListener("loadstart", ls);
    promotedElement.addEventListener("loadedmetadata", lm);
    promotedElement.addEventListener("loadeddata", ld);
    promotedElement.addEventListener("canplay", cp);
    promotedElement.addEventListener("seeked", sk);
    promotedElement.addEventListener("playing", pl);
    promotedElement.addEventListener("error", er);
    promotedElement.addEventListener("contextmenu", cm);

    // 既に canplay/loadeddata/loadedmetadata 到達済みのはずなので、合成イベント
    // として手動で通知して親の videoReady を立てる (新規 listener では二度と
    // 発火しない可能性あり)。
    //
    // 旧実装は queueMicrotask で遅延発火し `adoptedRef.current !== promotedElement`
    // のとき drop していたが、rapid swipe で adopt 直後にもう一度 promoted swap が
    // 起きるケースで synthetic event が握りつぶされ「動画は取れているのに
    // thumbnail-cover + spinner が残り続ける」状態を誘発していた (P5)。
    // adopt は同期で完了しており adoptedRef はこの直後の return まで確実に
    // promotedElement を指すため、microtask に遅延させずこの場で直接呼ぶ。
    if (promotedElement.readyState >= 3) {
      onCanPlay();
    } else if (promotedElement.readyState >= 2) {
      onLoadedData();
    } else if (promotedElement.readyState >= 1) {
      onLoadedMetadata();
    }
    // adopt 時点で既に再生中 (promote 元の prefetch buffer が play() させていた
    // ケース、または rapid swipe 後の rebind ケース) なら、playing イベントは
    // この listener では二度と発火しないので onPlaying を同期で叩いて UI ready を
    // 立てる。canplay の synthetic 発火は readyState ベースで既に走っているが、
    // FeedItem 側の videoReady reset useEffect (deps: [item.slug, videoSrc]) が
    // useLayoutEffect の後に走って `setVideoReadyState(false)` で上書きする経路が
    // 存在し、その後 canplay event が再発火しないと thumbnail-cover が残る。
    // onPlaying を経由すれば次の playing event でも復帰できる。
    if (!promotedElement.paused && !promotedElement.ended) {
      onPlaying?.();
    }

    return () => {
      promotedElement.removeEventListener("loadstart", ls);
      promotedElement.removeEventListener("loadedmetadata", lm);
      promotedElement.removeEventListener("loadeddata", ld);
      promotedElement.removeEventListener("canplay", cp);
      promotedElement.removeEventListener("seeked", sk);
      promotedElement.removeEventListener("playing", pl);
      promotedElement.removeEventListener("error", er);
      promotedElement.removeEventListener("contextmenu", cm);
      // 「さっき見ていた動画」を pool に残す。retain 成功時は要素が document.body
      // 直下に移されるので、本クリーンアップでは追加の破棄処理をしない。
      // 条件: promote している slug と src が現在の props と一致 (途中で差し替わって
      // いない) かつ readyState>=3 (HAVE_FUTURE_DATA) だけ。それ以外は従来通り破棄。
      //
      // これにより、ユーザが上方向にスワイプして同じ slug に戻ってきたとき、
      // PrefetchVideoBuffer がその slug を +1 スロットとして registerPrefetchElement を
      // 呼ぶと reuse ヒットし (= readyState/バッファそのままを保持)、active 化時に
      // 即時 promote できる。
      const retained = retainActiveElementToPool({
        slug,
        src,
        el: promotedElement,
      });
      if (!retained) {
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
    slug,
    src,
    onLoadStart,
    onLoadedMetadata,
    onLoadedData,
    onCanPlay,
    onSeeked,
    onPlaying,
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

  // promoted 要素の src を上位の `src` (= videoSrc) に同期する。
  //
  // 背景: handoff で adopt した <video> 要素は元々 prefetch buffer 登録時の src を
  // 持っているが、active 再生中に
  //   - useResolvedVideoSrc.handleError() で force re-resolve が走り、API が新しい
  //     署名付き URL を返したケース (CDN 期限切れ等)
  //   - `video-active-stuck` 経由で FeedItem が handleError を呼んだケース
  // などで `videoSrc` (= 親の src prop) が新 URL に切り替わる。promoted 要素は
  // FeedItemVideo の JSX 経由で src を受け取らない (host にぶら下げただけ) ので
  // ここで明示的に同期しないと、active 要素は古い URL のまま rs=0 で固まり続ける。
  useEffect(() => {
    if (!promotedElement) return;
    if (!src) return;
    // currentSrc は絶対 URL、src 属性は相対のままになり得るので、両方と比較する。
    if (promotedElement.src === src || promotedElement.currentSrc === src) {
      return;
    }
    promotedElement.src = src;
    try {
      promotedElement.load();
    } catch {
      /* ignore */
    }
  }, [promotedElement, src]);

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
          onPlaying={onPlaying}
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
