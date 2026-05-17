"use client";

import { useState, useCallback } from "react";
import type { MovieCard } from "@/lib/api/feed";
import { useBookmarks } from "@/components/auth/BookmarksProvider";
import { signIn } from "next-auth/react";
import { useFeedPlayback } from "./feed/useFeedPlayback";
import FeedItemVideo from "./feed/FeedItemVideo";
import FeedItemMeta from "./feed/FeedItemMeta";
import FeedItemSideActions from "./feed/FeedItemSideActions";
import { itemStyle } from "./feed/feedItemStyle";
import MovieDetailModal from "./movie-detail/MovieDetailModal";

interface Props {
  item: MovieCard;
  isActive: boolean;
  isFirst: boolean;
  isSecond?: boolean;
  activeGenres?: string[];
  onGenreClick?: (genre: string) => void;
}

// MP4 ファイル名のフォールバック順。
// 1. _mhb_w.mp4 (新形式 / 大多数の作品)
// 2. mhb.mp4    (古い作品、アンダースコア無し旧形式)
// 3. _dmb_w.mp4 (中サイズフォールバック)
const MP4_FALLBACK_SUFFIXES = ["_mhb_w.mp4", "mhb.mp4", "_dmb_w.mp4"];

function switchSuffix(url: string, attemptIndex: number): string | null {
  // オリジナルは attemptIndex=0 として使うので、フォールバック是 attemptIndex>=1。
  if (attemptIndex <= 0 || attemptIndex >= MP4_FALLBACK_SUFFIXES.length) return null;
  // 現在の suffix を attemptIndex番目のものへ置換
  for (const suf of MP4_FALLBACK_SUFFIXES) {
    if (url.endsWith(suf)) {
      return url.slice(0, -suf.length) + MP4_FALLBACK_SUFFIXES[attemptIndex];
    }
  }
  return null;
}

export default function FeedItem({ item, isActive, isFirst, isSecond = false }: Props) {
  const [modalSlug, setModalSlug] = useState<string | null>(null);
  // サンプル動画 URL のフォールバック試行回数 (0 = オリジナル)
  const [mp4Attempt, setMp4Attempt] = useState(0);
  const { isAuthenticated, isBookmarked, toggle } = useBookmarks();

  const handleOpenModal = useCallback((slug: string) => {
    setModalSlug(slug);
  }, []);

  const handleToggleBookmark = useCallback(() => {
    if (!isAuthenticated) {
      // 未ログインのときは Twitter ログインを促す (主要プロバイダをデフォルトに)
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
    fastBadgeRef,
    overlayRef,
    isMuted,
    setVideoReady,
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
    onOpenModal: handleOpenModal,
  });

  const preloadAttr = isFirst || isSecond ? "auto" : "metadata";

  // オリジナル URL にフォールバック suffix を適用した URL を計算
  const videoSrc = (() => {
    if (!item.sample_movie_url) return null;
    if (mp4Attempt === 0) return item.sample_movie_url;
    return switchSuffix(item.sample_movie_url, mp4Attempt) ?? item.sample_movie_url;
  })();

  const handleVideoError = useCallback(() => {
    // 次のフォールバック URL があればそれを試す
    if (!item.sample_movie_url) return;
    const nextAttempt = mp4Attempt + 1;
    const nextUrl = switchSuffix(item.sample_movie_url, nextAttempt);
    if (nextUrl) {
      setMp4Attempt(nextAttempt);
    }
    // これ以上フォールバックが無い場合はサムネイル表示に落ちる
  }, [item.sample_movie_url, mp4Attempt]);

  // フォールバックを使い果たしたかどうか
  const isMp4Exhausted = mp4Attempt >= MP4_FALLBACK_SUFFIXES.length - 1;
  // 中央のスライド (isActive=true) だけ <video> を描画する。
  // 隣接スライドはサムネイルのみ表示して、同時に複数の
  // <video> 読み込みが走らないようにする。これでモバイル Safari の
  // 同時接続上限・帯域競合を避け、再生開始までの時間を短縮できる。
  const showVideo = isActive && videoSrc && !isMp4Exhausted;

  return (
    <>
      <section ref={sectionRef} className="feed-item" data-movie-id={item.id}>
        {showVideo ? (
          <FeedItemVideo
            src={videoSrc}
            preload={preloadAttr}
            containerRef={containerRef}
            shimmerRef={shimmerRef}
            fastBadgeRef={fastBadgeRef}
            overlayRef={overlayRef}
            videoRef={videoRef}
            onLoadedData={() => setVideoReady(true)}
            onCanPlay={() => setVideoReady(true)}
            onError={handleVideoError}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchCancel}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
            onClick={handlePcClick}
          />
        ) : (
          <div className="thumbnail-bg">
            <img
              src={item.image_url_large ?? item.image_url_list ?? ""}
              alt={item.title}
              className="thumbnail-img"
              loading={isFirst ? "eager" : "lazy"}
              width={720}
              height={1280}
            />
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
