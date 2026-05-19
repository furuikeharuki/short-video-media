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
  /**
   * 中央スライド (isActive) の直前/直後にマウントされている隣接スライドかどうか。
   * true のときは <video> をマウントして preload を進めるが play() はしない。
   * これにより、スワイプで中央に来た瞬間に既存の <video> へ play() するだけで
   * 済み、新規マウント → loadstart → loadedmetadata の連鎖が走らずに
   * 黒画面 + スピナーの一瞬挟まりを回避する。
   */
  isAdjacent?: boolean;
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

export default function FeedItem({ item, isActive, isAdjacent = false, isFirst, isSecond = false }: Props) {
  const [modalSlug, setModalSlug] = useState<string | null>(null);
  const { isAuthenticated, isBookmarked, toggle } = useBookmarks();

  // 表示する動画 URL の解決ロジック。
  // - cachedSrc を optimistic に使い、無ければ API を叩く
  // - <video> がエラーを返したら 1 回だけ force=true で再 resolve する
  // 隣接スライド (isAdjacent) でも URL 解決を走らせて、スワイプ到達時に
  // すでに <video> が読み込み済みになっているようにする。
  const { videoSrc, exhausted, handleError } = useResolvedVideoSrc({
    slug: item.slug,
    cachedSrc: item.sample_movie_url,
    enabled: isActive || isAdjacent,
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
    // resolver で URL を遅延取得したときでも、<video> マウント直後に自動再生を起動させる
    videoSrc,
    onOpenModal: handleOpenModal,
    // プロ女優 (videoa) 作品は先頭 5 秒スキップ + 戻し不可
    isProActress: item.genres?.includes(PRO_ACTRESS_GENRE) ?? false,
  });

  // 隣接スライド (isAdjacent) でもメディアバイトを先読みしておくため "auto" を採用。
  // スワイプで中央に来た瞬間、すでに loadedmetadata / loadeddata まで進んでいる状態を作る。
  const preloadAttr = isFirst || isSecond || isActive || isAdjacent ? "auto" : "metadata";

  // <video> がロードを開始したときのハンドラ。
  // 以前はここで shimmer (サムネ) を表示していたが、ロード中にサムネが一瞬見える
  // チラつきを避けるため、現在は何もしない (スピナーは useFeedPlayback の
  // waiting/stalled イベントと遅延タイマーで制御される)。
  // サムネは onError 時のフォールバック用途に限定された。
  const handleLoadStart = useCallback(() => {
    // no-op (以前は setShimmerVisible(true))
  }, []);

  // loadedmetadata も現在は何もしない (もともと shimmer を消すためだけのハンドラだった)。
  const handLoadedMetadataNoop = useCallback(() => {}, []);
  const handleLoadedMetadata = handLoadedMetadataNoop;

  const handleLoadedData = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    setVideoReady(true);
    // 初回ロードが完了したらスピナーを消す。その後は waiting/playing イベントで制御される。
    setSpinnerVisible(false);
    // 今回のロードが成功したので、以前のエラーで出ていた shimmer も明示的に隠しておく。
    setShimmerVisible(false);
  }, [setVideoReady, setSpinnerVisible, setShimmerVisible, clearHardTimeout]);

  const handleVideoError = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    // サムネ (shimmer) はここでは出さない。再生中の force リトライでは <video> の現フレームを
    // できるだけ保持し、スピナーのみ表示する (useFeedPlayback の waiting/stalled で補う)。
    // リトライも使い切って exhausted になった場合は、useResolvedVideoSrc が videoSrc=null を返し、
    // FeedItem 上位の thumbnail-bg 経路でサムネが表示されるため、ここで明示的にサムネを出す必要はない。
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

  // 中央のスライド (isActive=true) と隣接スライド (isAdjacent=true) で <video> を描画する。
  // 隣接スライドの <video> は preload="auto" でメディアバイトの先読みを進めておくが、
  // useFeedPlayback の自動再生 effect は isActive=true のときしか動かないため、
  // 隣接スライドの <video> は paused のままバッファだけ温まる。
  // スワイプで中央に来た瞬間、既存の <video> インスタンスへ play() するだけで
  // 済むので、新規マウント由来の黒画面+スピナーが入らない。
  // モバイル Safari の同時接続上限 (約 4) は 中央 1 + 隣接 2 + currentIndex+2 の隠し先読み 1 = 計 4 で上限ギリギリ。
  const showVideo = (isActive || isAdjacent) && videoSrc !== null && !exhausted;

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
            onLoadStart={handleLoadStart}
            onLoadedMetadata={handleLoadedMetadata}
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
              サムネ表示中はホボ確実に「まだロード中」なのでスピナーを常に重ねる。
              - resolving (初回問い合わせ中): スピナー表示
              - retrying (force リトライ中): スピナー表示
              - exhausted (リトライも全て試行済み): これもスピナー表示しておく。
                useResolvedVideoSrc が enabled=false→true 遷移 (スワイプで戻ってきたときなど) で
                自動再試行するため、スピナーを出してロードインジケータを保つとユーザーにモヤモヤ感がない。
              videoSrc が返ってくると showVideo=true に切り替わり、<video> がマウントされて useFeedPlayback が
              isActive=true のタイミングで自動的に play() を呼ぶ。
            */}
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
