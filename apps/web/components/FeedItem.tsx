"use client";

import { useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { MovieCard } from "@/lib/api/feed";
import { useBookmarks } from "@/components/auth/BookmarksProvider";
import { signIn } from "next-auth/react";
import { useFeedPlayback } from "./feed/useFeedPlayback";
import { useResolvedVideoSrc } from "./feed/useResolvedVideoSrc";
import { createVideoTimer, isVideoTimingEnabled } from "@/lib/videoTiming";
import {
  isProActressMovie,
  logProActressDecision,
} from "@/lib/proActress";
import FeedItemVideo from "./feed/FeedItemVideo";
import FeedItemMeta from "./feed/FeedItemMeta";
import FeedItemSideActions from "./feed/FeedItemSideActions";
import { itemStyle } from "./feed/feedItemStyle";
import MovieDetailModal from "./movie-detail/MovieDetailModal";
import {
  claimForFeed,
  getReadiness,
  hasPromotableElement,
} from "@/lib/videoHandoff";

interface Props {
  item: MovieCard;
  isActive: boolean;
  /**
   * 中央スライド (isActive) の直前/直後にマウントされている隣接スライドかどうか。
   * true のときは <video> をマウントして preload を進めるが play() はしない。
   */
  isAdjacent?: boolean;
  isFirst: boolean;
  isSecond?: boolean;
  /**
   * FeedViewer から伝えられる高速スワイプ状態。
   * true の間は隣接スライドの <video> の preload を "metadata" に弱める。
   */
  isRapidSwiping?: boolean;
  activeGenres?: string[];
  onGenreClick?: (genre: string) => void;
}

// ハードタイムアウト: <video> が loadeddata も error も発火しないまま
// これだけ経ったら、ネットワーク進行不能とみなして onError 相当のリトライを走らせる。
const VIDEO_HARD_TIMEOUT_MS = 25000;

export default function FeedItem({ item, isActive, isAdjacent = false, isFirst, isSecond = false, isRapidSwiping = false }: Props) {
  const [modalSlug, setModalSlug] = useState<string | null>(null);
  const { isAuthenticated, isBookmarked, toggle } = useBookmarks();

  // 表示する動画 URL の解決。API は high_mp4_url / low_mp4_url を返し得るが、
  // 単一 <video> 戦略では `high_mp4_url || mp4_url` のみを使う。
  const { videoSrc, exhausted, handleError } = useResolvedVideoSrc({
    slug: item.slug,
    enabled: isActive || isAdjacent,
  });

  // prefetch buffer から canplay 済み要素を引き取れたら、新規 <video> を作らずに
  // そのまま active に流用する。
  //
  // render フェーズで registry を sync 読みして「promote 可能か」を判定するため、
  // 余計な JSX <video> がマウント→即廃棄される無駄がない。claim 自体は副作用
  // (registry mutation + log) なので useLayoutEffect で行う。useLayoutEffect は
  // passive useEffect より前に走るので、同じ commit で buffer がアンマウントする
  // 場合でも先に claim できる (buffer 側の releasePrefetchElement は passive
  // cleanup として後段で走る)。
  const [promotedElement, setPromotedElement] =
    useState<HTMLVideoElement | null>(null);
  const promotedSlugRef = useRef<string | null>(null);
  const canPromote =
    isActive && !!videoSrc && hasPromotableElement(item.slug, videoSrc);
  useLayoutEffect(() => {
    if (!isActive) return;
    if (!videoSrc) return;
    if (promotedSlugRef.current === item.slug) return;
    if (!hasPromotableElement(item.slug, videoSrc)) return;
    // readiness を先に読んでからログする (claim 後はレジストリが空になる)
    const readiness = getReadiness(item.slug) ?? "canplay";
    const el = claimForFeed(item.slug, videoSrc);
    if (!el) return;
    promotedSlugRef.current = item.slug;
    setPromotedElement(el);
    if (isVideoTimingEnabled()) {
      // eslint-disable-next-line no-console
      console.debug(
        `vt byte-prefetch promote slug=${item.slug} readiness=${readiness}`,
      );
    }
  }, [isActive, videoSrc, item.slug]);
  // slug 変更で promoted を捨てる (別作品にスワイプして戻ってきた等)。
  useEffect(() => {
    if (promotedSlugRef.current && promotedSlugRef.current !== item.slug) {
      promotedSlugRef.current = null;
      setPromotedElement(null);
    }
  }, [item.slug]);

  const isProActress = isProActressMovie(item.genres);

  useEffect(() => {
    if (!isActive) return;
    logProActressDecision(item.slug, item.genres);
  }, [isActive, item.slug, item.genres]);

  const [videoReady, setVideoReadyState] = useState(false);

  const hardTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoSettledRef = useRef(false);
  const clearHardTimeout = useCallback(() => {
    if (hardTimeoutRef.current) {
      clearTimeout(hardTimeoutRef.current);
      hardTimeoutRef.current = null;
    }
  }, []);

  const handleOpenModal = useCallback((slug: string) => {
    setModalSlug(slug);
  }, []);

  const handleToggleBookmark = useCallback(() => {
    if (!isAuthenticated) {
      signIn("twitter", { callbackUrl: window.location.href });
      return;
    }
    void toggle(item.id);
  }, [isAuthenticated, toggle, item.id]);

  const {
    videoRef,
    sectionRef,
    containerRef,
    shimmerRef,
    spinnerRef,
    fastBadgeRef,
    overlayRef,
    isMuted,
    setVideoReady,
    setShimmerVisible,
    setSpinnerVisible,
    handleToggleMute,
    handleShare,
    handleDetail,
    handleTouchStart,
    handleTouchEnd,
    handleTouchCancel,
    handleMouseDown,
    handleMouseUp,
    handleMouseLeave,
    handlePcClick,
  } = useFeedPlayback({
    slug: item.slug,
    title: item.title,
    isActive,
    videoSrc,
    onOpenModal: handleOpenModal,
    isProActress,
  });

  // preload 戦略:
  //  - isActive (中央): 常に "auto"。中央動画の resolve / 再生は最優先。
  //  - isAdjacent (隣接) 通常時: "auto" でメディアバイトを先読み。
  //  - isAdjacent + 高速スワイプ中: "metadata" に弱める。
  //  - isFirst / isSecond の初期マウント: "auto" でファーストビューを早める。
  //  - その他: "metadata"。
  let preloadAttr: "auto" | "metadata";
  if (isActive) {
    preloadAttr = "auto";
  } else if (isAdjacent) {
    preloadAttr = isRapidSwiping ? "metadata" : "auto";
  } else if (isFirst || isSecond) {
    preloadAttr = "auto";
  } else {
    preloadAttr = "metadata";
  }

  const handleLoadStart = useCallback(() => {
    // no-op (ロード中のサムネ表示は thumbnail-cover で別経路)
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
  }, [clearHardTimeout]);

  const handleLoadedData = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    setVideoReady(true);
    setVideoReadyState(true);
    setSpinnerVisible(false);
    setShimmerVisible(false);
  }, [setVideoReady, setSpinnerVisible, setShimmerVisible, clearHardTimeout]);

  const handleCanPlay = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    setVideoReady(true);
    setVideoReadyState(true);
    setSpinnerVisible(false);
    setShimmerVisible(false);
  }, [setVideoReady, setSpinnerVisible, setShimmerVisible, clearHardTimeout]);

  const handleSeeked = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    setVideoReady(true);
    setVideoReadyState(true);
    setSpinnerVisible(false);
    setShimmerVisible(false);
  }, [setVideoReady, setSpinnerVisible, setShimmerVisible, clearHardTimeout]);

  const handleVideoError = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    if (!isActive) {
      return;
    }
    handleError();
  }, [handleError, clearHardTimeout, isActive]);

  useEffect(() => {
    if (!isActive || !videoSrc) {
      clearHardTimeout();
      return;
    }
    videoSettledRef.current = false;
    clearHardTimeout();
    hardTimeoutRef.current = setTimeout(() => {
      if (!videoSettledRef.current) {
        handleVideoError();
      }
    }, VIDEO_HARD_TIMEOUT_MS);
    return clearHardTimeout;
  }, [isActive, videoSrc, handleVideoError, clearHardTimeout]);

  useEffect(() => {
    setVideoReadyState(false);
  }, [item.slug, videoSrc]);

  // 開発用: video の lifecycle 時刻を計測してログ出力する。
  useEffect(() => {
    if (!isVideoTimingEnabled()) return;
    if (!isActive) return;
    if (!videoSrc) return;
    const video = videoRef.current;
    if (!video) return;

    const timer = createVideoTimer(item.slug);
    timer.mark("video:src-attached");

    const onLoadStart = () => timer.mark("loadstart");
    const onLoadedMetadata = () => timer.mark("loadedmetadata");
    const onCanPlay = () => timer.mark("canplay");
    const onPlaying = () => timer.mark("playing");
    const onWaiting = () => timer.mark("waiting");
    const onStalled = () => timer.mark("stalled");
    const onError = () => timer.mark("error");

    video.addEventListener("loadstart", onLoadStart);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onStalled);
    video.addEventListener("error", onError);
    return () => {
      video.removeEventListener("loadstart", onLoadStart);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onStalled);
      video.removeEventListener("error", onError);
    };
  }, [isActive, videoSrc, item.slug, videoRef]);

  const showVideo =
    (isActive || isAdjacent) && videoSrc !== null && !exhausted;

  return (
    <>
      <section ref={sectionRef} className="feed-item" data-movie-id={item.id}>
        {showVideo ? (
          <>
            <FeedItemVideo
              src={videoSrc as string}
              preload={preloadAttr}
              containerRef={containerRef}
              shimmerRef={shimmerRef}
              spinnerRef={spinnerRef}
              fastBadgeRef={fastBadgeRef}
              overlayRef={overlayRef}
              videoRef={videoRef}
              thumbnailUrl={item.image_url_large ?? item.image_url_list ?? ""}
              thumbnailAlt={item.title}
              onLoadStart={handleLoadStart}
              onLoadedMetadata={handleLoadedMetadata}
              onLoadedData={handleLoadedData}
              onCanPlay={handleCanPlay}
              onSeeked={handleSeeked}
              onError={handleVideoError}
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
              onTouchCancel={handleTouchCancel}
              onMouseDown={handleMouseDown}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseLeave}
              onClick={handlePcClick}
              promotedElement={promotedElement}
              expectingPromotion={canPromote && !promotedElement}
            />
            {isActive && !videoReady && (
              <div
                className="thumbnail-cover"
                aria-hidden="true"
                onContextMenu={(e) => e.preventDefault()}
              >
                <img
                  src={item.image_url_large ?? item.image_url_list ?? ""}
                  alt={item.title}
                  className="thumbnail-img"
                  loading="eager"
                  width={720}
                  height={1280}
                  draggable={false}
                  onContextMenu={(e) => e.preventDefault()}
                />
              </div>
            )}
          </>
        ) : (
          <div
            className="thumbnail-bg"
            onContextMenu={(e) => e.preventDefault()}
          >
            <img
              src={item.image_url_large ?? item.image_url_list ?? ""}
              alt={item.title}
              className="thumbnail-img"
              loading={isFirst ? "eager" : "lazy"}
              width={720}
              height={1280}
              draggable={false}
              onContextMenu={(e) => e.preventDefault()}
            />
            {isActive ? (
              <div className="overlay-wrap">
                <div
                  className="loading-spinner"
                  aria-label="動画を読み込み中"
                  style={{ display: "flex" }}
                />
              </div>
            ) : null}
          </div>
        )}

        <div className="bottom-bar">
          <FeedItemMeta item={item} />
          <FeedItemSideActions
            item={item}
            isMuted={isMuted}
            isBookmarked={isBookmarked(item.id)}
            onToggleMute={handleToggleMute}
            onToggleBookmark={handleToggleBookmark}
            onShare={handleShare}
            onDetail={handleDetail}
          />
        </div>

        <style>{itemStyle}</style>
      </section>

      {modalSlug && (
        <MovieDetailModal
          slug={modalSlug}
          onClose={() => setModalSlug(null)}
        />
      )}
    </>
  );
}
