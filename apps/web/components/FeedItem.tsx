"use client";

import { useRouter } from "next/navigation";
import type { MovieCard } from "@/lib/api/feed";
import { useFeedPlayback } from "./feed/useFeedPlayback";
import FeedItemVideo from "./feed/FeedItemVideo";
import FeedItemMeta from "./feed/FeedItemMeta";
import FeedItemSideActions from "./feed/FeedItemSideActions";
import { itemStyle } from "./feed/feedItemStyle";

interface Props {
  item: MovieCard;
  isFirst: boolean;
  isSecond?: boolean;
  activeGenres?: string[];
  onGenreClick?: (genre: string) => void;
}

export default function FeedItem({ item, isFirst, isSecond = false }: Props) {
  const router = useRouter();

  const {
    videoRef,
    sectionRef,
    containerRef,
    shimmerRef,
    fastBadgeRef,
    overlayRef,
    isMuted,
    isBookmarked,
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
    toggleBookmark,
  } = useFeedPlayback({
    slug: item.slug,
    title: item.title,
    onNavigate: (path) => router.push(path),
  });

  const preloadAttr = isFirst || isSecond ? "auto" : "metadata";

  return (
    <section ref={sectionRef} className="feed-item" data-movie-id={item.id}>
      {item.sample_movie_url ? (
        <FeedItemVideo
          src={item.sample_movie_url}
          preload={preloadAttr}
          containerRef={containerRef}
          shimmerRef={shimmerRef}
          fastBadgeRef={fastBadgeRef}
          overlayRef={overlayRef}
          videoRef={videoRef}
          onLoadedData={() => setVideoReady(true)}
          onCanPlay={() => setVideoReady(true)}
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
          isBookmarked={isBookmarked}
          onToggleMute={handleToggleMute}
          onToggleBookmark={toggleBookmark}
          onShare={handleShare}
          onDetail={handleDetail}
        />
      </div>

      <style>{itemStyle}</style>
    </section>
  );
}
