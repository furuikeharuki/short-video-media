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

  // ハンドラ props を ref に常時同期する。これにより event listener 側は
  // 「呼び出し時点で最新の handler を読む」だけで済み、handler identity が
  // 変わってもリスナを付け直す必要が無くなる。
  //
  // 旧実装は adopt/destroy + listener attach を 1 つの useLayoutEffect にまとめ、
  // その依存配列に handler props を含めていた。FeedItem 側で handleVideoError や
  // handleLoadStart の identity が isActive / forceFallbackSlug / fallbackEpoch /
  // item.slug の変化で変わるたびに effect が再実行され、cleanup で promoted
  // <video> を pause + removeAttribute('src') + load() + removeChild してしまい、
  // canplay 済みだった要素が rs=0 に巻き戻る → src 同期 useEffect が再 load →
  // useFeedPlayback の active autoplay promote force-load + hardResetActiveLoad
  // が走って `loadedmetadata +3〜5s / canplay +5〜12s` の遅延が観測されていた。
  // adopt/destroy と listener attach を独立 effect に分け、listener attach 側は
  // ref 経由で handler を読むことで、handler identity 変動の影響を完全に切り離す。
  const onLoadStartRef = useRef(onLoadStart);
  const onLoadedMetadataRef = useRef(onLoadedMetadata);
  const onLoadedDataRef = useRef(onLoadedData);
  const onCanPlayRef = useRef(onCanPlay);
  const onSeekedRef = useRef(onSeeked);
  const onPlayingRef = useRef(onPlaying);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onLoadStartRef.current = onLoadStart;
  }, [onLoadStart]);
  useEffect(() => {
    onLoadedMetadataRef.current = onLoadedMetadata;
  }, [onLoadedMetadata]);
  useEffect(() => {
    onLoadedDataRef.current = onLoadedData;
  }, [onLoadedData]);
  useEffect(() => {
    onCanPlayRef.current = onCanPlay;
  }, [onCanPlay]);
  useEffect(() => {
    onSeekedRef.current = onSeeked;
  }, [onSeeked]);
  useEffect(() => {
    onPlayingRef.current = onPlaying;
  }, [onPlaying]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // (A) adopt / destroy lifecycle。promotedElement が実際に変わった (= 別要素に
  // rebind された、または null になった) ときだけ走る。preload や handler 変動では
  // 走らない。
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
    promotedElement.style.opacity = promotedElement.readyState >= 2 ? "1" : "0";
    promotedElement.style.pointerEvents = "";
    promotedElement.style.zIndex = "";
    promotedElement.className = "feed-video";
    promotedElement.muted = true;
    promotedElement.loop = true;
    promotedElement.playsInline = true;
    promotedElement.controls = false;
    // 初期 preload はマウント時点の prop で設定する。以降の変動は別 useEffect が同期。
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
    //
    // ref 経由で最新の handler を読む (この時点では useEffect で同期される
    // タイミングより前だが、ref には初期値として最新 prop が入っている)。
    if (promotedElement.readyState >= 3) {
      onCanPlayRef.current();
    } else if (promotedElement.readyState >= 2) {
      onLoadedDataRef.current();
    } else if (promotedElement.readyState >= 1) {
      onLoadedMetadataRef.current();
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
      onPlayingRef.current?.();
    }

    return () => {
      // host からのデタッチと完全破棄。本当に promotedElement が変わった or null
      // になった (= unmount) ときだけ走る。handler identity 変動では走らない。
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
    // 依存配列は意図的に promotedElement / videoRef のみ。handler や preload の
    // 変動で adopt/destroy を再走させないこと。preload の追従は別 useEffect、
    // handler はリスナ側 useEffect (B) で別管理する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promotedElement, videoRef]);

  // (B) promoted 要素へのイベントリスナ attach。adopt が完了した promoted 要素に
  // 対してのみ走る。中身は ref 経由で最新 handler を呼ぶだけなので、handler
  // identity が変わっても再 attach は不要。adoptedRef を見ることで「destroy
  // cleanup と同 commit で adopt が走る」レースを避けつつ、promoted 自体が
  // 変わったときだけ listener も付け替える。
  useEffect(() => {
    if (!promotedElement) return;
    const ls = () => onLoadStartRef.current();
    const lm = () => onLoadedMetadataRef.current();
    const ld = () => onLoadedDataRef.current();
    const cp = () => onCanPlayRef.current();
    const sk = () => onSeekedRef.current();
    const pl = () => onPlayingRef.current?.();
    const er = (e: Event) => onErrorRef.current?.(e);
    const cm = (e: Event) => e.preventDefault();

    promotedElement.addEventListener("loadstart", ls);
    promotedElement.addEventListener("loadedmetadata", lm);
    promotedElement.addEventListener("loadeddata", ld);
    promotedElement.addEventListener("canplay", cp);
    promotedElement.addEventListener("seeked", sk);
    promotedElement.addEventListener("playing", pl);
    promotedElement.addEventListener("error", er);
    promotedElement.addEventListener("contextmenu", cm);

    return () => {
      promotedElement.removeEventListener("loadstart", ls);
      promotedElement.removeEventListener("loadedmetadata", lm);
      promotedElement.removeEventListener("loadeddata", ld);
      promotedElement.removeEventListener("canplay", cp);
      promotedElement.removeEventListener("seeked", sk);
      promotedElement.removeEventListener("playing", pl);
      promotedElement.removeEventListener("error", er);
      promotedElement.removeEventListener("contextmenu", cm);
    };
  }, [promotedElement]);

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
    const el = promotedElement;
    const resumeAt = el.currentTime;
    const shouldResume = Number.isFinite(resumeAt) && resumeAt > 0.5;
    el.src = src;
    try {
      el.load();
    } catch {
      /* ignore */
    }
    if (!shouldResume) return;
    let settled = false;

    function cleanup() {
      el.removeEventListener("loadedmetadata", restore);
      el.removeEventListener("loadeddata", restore);
      el.removeEventListener("canplay", restore);
      el.removeEventListener("timeupdate", restore);
    }

    function restore() {
      if (settled) return;
      const dur = el.duration;
      if (!Number.isFinite(dur) || resumeAt >= dur - 0.5) {
        settled = true;
        cleanup();
        return;
      }
      if (el.currentTime >= resumeAt - 0.5) {
        settled = true;
        cleanup();
        return;
      }
      try {
        el.currentTime = resumeAt;
      } catch {
        /* ignore */
      }
    }
    el.addEventListener("loadedmetadata", restore);
    el.addEventListener("loadeddata", restore);
    el.addEventListener("canplay", restore);
    el.addEventListener("timeupdate", restore);
    if (el.readyState >= 1) restore();
    return cleanup;
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
