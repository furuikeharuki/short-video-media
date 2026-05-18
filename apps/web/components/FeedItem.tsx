"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { MovieCard } from "@/lib/api/feed";
import { useBookmarks } from "@/components/auth/BookmarksProvider";
import { signIn } from "next-auth/react";
import { useFeedPlayback } from "./feed/useFeedPlayback";
import { useResolvedVideoSrc } from "./feed/useResolvedVideoSrc";
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

// 動画 URL の解決と再生エラー時の force リトライは useResolvedVideoSrc に集約。
// 旧来の「cid バリエーション × suffix プローブ」ロジックは API 側
// (apps/api + apps/resolver) に置き換わったため、ここではシンプルに
// resolve-mp4 を呼ぶだけになる。

// ハードタイムアウト: <video> が loadedmetadata も error も発火しないまま
// これだけ経ったら、ネットワーク進行不能とみなして onError 相当のリトライを走らせる。
const VIDEO_HARD_TIMEOUT_MS = 8000;

// 「プロ女優」(= sync_catalog で videoa フロアの作品全部に付与される擬似ジャンル)。
// このジャンルが付いている作品は先頭 5 秒をスキップして再生する仕様。
// FeedItem は アプリ内で動画を再生する唯一の入口 (検索 / 女優ページ / ブックマーク等
// どこから来ても FeedViewer 経由で FeedItem に到達する) ため、ここで判定すれば
// すべてのアクセス経路で 5 秒スキップが効く。
const PRO_ACTRESS_GENRE = "プロ女優";

export default function FeedItem({ item, isActive, isFirst, isSecond = false }: Props) {
  const [modalSlug, setModalSlug] = useState<string | null>(null);
  const { isAuthenticated, isBookmarked, toggle } = useBookmarks();

  // 表示する動画 URL の解決ロジック。
  // - cachedSrc を optimistic に使い、無ければ API を叩く
  // - <video> がエラーを返したら 1 回だけ force=true で再 resolve する
  const { videoSrc, exhausted, resolving, handleError } = useResolvedVideoSrc({
    slug: item.slug,
    cachedSrc: item.sample_movie_url,
    enabled: isActive,
  });

  // ハードタイムアウト管理。videoSrc が変わるたびにタイマーを仕掛け直す。
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
    spinnerRef,
    fastBadgeRef,
    overlayRef,
    isMuted,
    setVideoReady,
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
    // resolver で URL を遅延取得したときでも、<video> マウント直後に自動再生を起動させる
    videoSrc,
    onOpenModal: handleOpenModal,
    // プロ女優 (videoa) 作品は先頭 5 秒スキップ + 戻し不可
    isProActress: item.genres?.includes(PRO_ACTRESS_GENRE) ?? false,
  });

  const preloadAttr = isFirst || isSecond ? "auto" : "metadata";

  const handleLoadedData = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    setVideoReady(true);
    // 初回ロードが完了したらスピナーも一旦消す。その後は waiting/playing イベントで制御される。
    setSpinnerVisible(false);
  }, [setVideoReady, setSpinnerVisible, clearHardTimeout]);

  const handleVideoError = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    handleError();
  }, [handleError, clearHardTimeout]);

  // videoSrc が変わるたびにハードタイムアウトをセットし直す。
  // VIDEO_HARD_TIMEOUT_MS 以内に loadedmetadata / error が発火しないと
  // 強制的に handleVideoError を呼んでリトライ (または exhausted) を進める。
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

  // 中央のスライド (isActive=true) だけ <video> を描画する。
  // 隣接スライドはサムネイルのみ表示して、同時に複数の
  // <video> 読み込みが走らないようにする。これでモバイル Safari の
  // 同時接続上限・帯域競合を避け、再生開始までの時間を短縮できる。
  const showVideo = isActive && videoSrc !== null && !exhausted;

  return (
    <>
      <section ref={sectionRef} className="feed-item" data-movie-id={item.id}>
        {showVideo ? (
          <FeedItemVideo
            src={videoSrc}
            preload={preloadAttr}
            containerRef={containerRef}
            shimmerRef={shimmerRef}
            spinnerRef={spinnerRef}
            fastBadgeRef={fastBadgeRef}
            overlayRef={overlayRef}
            videoRef={videoRef}
            thumbnailUrl={item.image_url_large ?? item.image_url_list ?? ""}
            thumbnailAlt={item.title}
            onLoadedData={handleLoadedData}
            onCanPlay={() => { setVideoReady(true); setSpinnerVisible(false); }}
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
            {/*
              resolver へ MP4 URL を問い合わせている間はサムネの上に既存のローディングスピナーを表示しておく。
              videoSrc が返ってくると showVideo=true に切り替わり、<video> がマウントされて useFeedPlayback が
              isActive=true のタイミングで自動的に play() を呼ぶ (useFeedPlayback.ts L218-228)。
              exhausted (resolve 試行を使い切った) 状態ではスピナーを出さずサムネのみ表示する。
            */}
            {isActive && resolving && !exhausted ? (
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
