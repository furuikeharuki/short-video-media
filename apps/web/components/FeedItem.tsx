"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { MovieCard } from "@/lib/api/feed";
import { useBookmarks } from "@/components/auth/BookmarksProvider";
import { signIn } from "next-auth/react";
import { useFeedPlayback } from "./feed/useFeedPlayback";
import { useResolvedVideoSrc } from "./feed/useResolvedVideoSrc";
import { createVideoTimer, isVideoTimingEnabled } from "@/lib/videoTiming";
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
  /**
   * FeedViewer から伝えられる高速スワイプ状態。
   * true の間は隣接スライドの <video> の preload を "metadata" に弱め、
   * 中央 (isActive) の resolve / Range 取得が同時接続枠と帯域を奪われないようにする。
   */
  isRapidSwiping?: boolean;
  activeGenres?: string[];
  onGenreClick?: (genre: string) => void;
}

// 動画 URL の解決と再生エラー時の force リトライは useResolvedVideoSrc に集約。
// 旧来の「cid バリエーション × suffix プローブ」ロジックは API 側
// (apps/api + apps/resolver) に置き換わったため、ここではシンプルに
// resolve-mp4 を呼ぶだけになる。

// ハードタイムアウト: <video> が loadeddata も error も発火しないまま
// これだけ経ったら、ネットワーク進行不能とみなして onError 相当のリトライを走らせる。
// resolver の 抽出に 9 秒以上かかるケースもあるため、その後の動画ダウンロード
// タイムも含めて 25 秒以上を見ておく。以前は 8 秒だったため、resolver が
// 返した URL の MP4 ダウンロードが進行中にタイムアウトが発火して、force
// リトライで src が切り替わり原ロードが canceled されるケースがあった。
const VIDEO_HARD_TIMEOUT_MS = 25000;

// 「プロ女優」(= sync_catalog で videoa フロアの作品全部に付与される擬似ジャンル)。
// このジャンルが付いている作品は先頭 5 秒をスキップして再生する仕様。
// FeedItem は アプリ内で動画を再生する唯一の入口 (検索 / 女優ページ / ブックマーク等
// どこから来ても FeedViewer 経由で FeedItem に到達する) ため、ここで判定すれば
// すべてのアクセス経路で 5 秒スキップが効く。
const PRO_ACTRESS_GENRE = "プロ女優";

export default function FeedItem({ item, isActive, isAdjacent = false, isFirst, isSecond = false, isRapidSwiping = false }: Props) {
  const [modalSlug, setModalSlug] = useState<string | null>(null);
  const { isAuthenticated, isBookmarked, toggle } = useBookmarks();

  // 表示する動画 URL の解決ロジック。
  // - API (resolve-mp4) を都度叩いて取得する (DB キャッシュ無し)
  // - <video> がエラーを返したら 1 回だけ force=true で再 resolve する
  // 隣接スライド (isAdjacent) でも URL 解決を走らせて、スワイプ到達時に
  // すでに <video> が読み込み済みになっているようにする。
  const { videoSrc, exhausted, handleError } = useResolvedVideoSrc({
    slug: item.slug,
    enabled: isActive || isAdjacent,
  });

  // <video> が loadeddata / seeked / canplay に到達したかどうかの React state。
  // これが false の間 = まだ黒画面の可能性があるので、thumbnail-bg-overlay (サムネ画像) を
  // <video> の上に被せて黒画面を隠す。ここは opacity DOM 直接操作とは独立した
  // React state。 useFeedPlayback 側の setVideoReady は 引き続き <video> の opacity を調整する。
  const [videoReady, setVideoReadyState] = useState(false);

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

  // preload 戦略:
  //  - isActive (中央): 常に "auto"。中央動画の resolve / 再生は最優先。
  //  - isAdjacent (隣接) 通常時: "auto" でメディアバイトを先読み。スワイプ中央到達で
  //    黒画面を避ける。
  //  - isAdjacent + 高速スワイプ中: "metadata" に弱める。隣接スライドのバイトより
  //    中央スライドの Range 取得 / resolve のほうを優先したい。
  //  - isFirst / isSecond の初期マウント: "auto" でファーストビューを早める。
  //  - その他 (理論上ここには来ない): "metadata"。
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

  // <video> がロードを開始したときのハンドラ。
  // 以前はここで shimmer (サムネ) を表示していたが、ロード中にサムネが一瞬見える
  // チラつきを避けるため、現在は何もしない (スピナーは useFeedPlayback の
  // waiting/stalled イベントと遅延タイマーで制御される)。
  // サムネは onError 時のフォールバック用途に限定された。
  const handleLoadStart = useCallback(() => {
    // no-op (以前は setShimmerVisible(true))
  }, []);

  // loadedmetadata が発火した時点で MP4 ヘッダーのダウンロードは進んでいるため、ネットワーク進行
  // 不能とは見なさない。ハードタイムアウトはここで settle 扱いにして、以降 loadeddata
  // までの間に force リトライが誤発しないようにする。
  const handleLoadedMetadata = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
  }, [clearHardTimeout]);

  const handleLoadedData = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    setVideoReady(true);
    setVideoReadyState(true);
    // 初回ロードが完了したらスピナーを消す。その後は waiting/playing イベントで制御される。
    setSpinnerVisible(false);
    // 今回のロードが成功したので、以前のエラーで出ていた shimmer も明示的に隠しておく。
    setShimmerVisible(false);
  }, [setVideoReady, setSpinnerVisible, setShimmerVisible, clearHardTimeout]);

  // canplay も loadeddata と同様に settle 扱いにする。ブラウザによっては loadeddata よりも
  // canplay が先に発火したり、逆に loadeddata だけ上がって canplay が遅れるケースがあるため、
  // どちらでもハードタイムアウトを clear して force リトライの誤発を防ぐ。
  const handleCanPlay = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    setVideoReady(true);
    setVideoReadyState(true);
    setSpinnerVisible(false);
    setShimmerVisible(false);
  }, [setVideoReady, setSpinnerVisible, setShimmerVisible, clearHardTimeout]);

  // seeked も 「その位置の 1 フレームがデコードされた」 を意味するため settle 扱い。
  // 特にプロ女優作品は loadedmetadata 後に currentTime=5 にシークされるため、
  // loadeddata (0 秒地点のフレーム) よりも seeked (5 秒地点のフレーム) の方が
  // 意図したプレビュー画面として適切。そのタイミングで opacity:1 にして
  // 黒画面を最小限にする。
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
    // 隣接スライド (isActive=false) の <video> が onError を出しても、そこで force リトライを
    // 走らせると不要な resolver アクセスが多発し、本当に中央にきたときの負荷を上げてしまう。
    // 中央にスワイプしてきたときに同じ src でロードが再試行されるので、そのタイミングのエラーで
    // 初めて force リトライが走るようにする。
    if (!isActive) {
      return;
    }
    // サムネ (shimmer) はここでは出さない。再生中の force リトライでは <video> の現フレームを
    // できるだけ保持し、スピナーのみ表示する (useFeedPlayback の waiting/stalled で補う)。
    // リトライも使い切って exhausted になった場合は、useResolvedVideoSrc が videoSrc=null を返し、
    // FeedItem 上位の thumbnail-bg 経路でサムネが表示されるため、ここで明示的にサムネを出す必要はない。
    handleError();
  }, [handleError, clearHardTimeout, isActive]);

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

  // slug または videoSrc が変わったら videoReady をリセット。
  // (同じ <video> 要素に新しい src が付いたケースも含めて、再ロード中はサムネ被せる)
  useEffect(() => {
    setVideoReadyState(false);
  }, [item.slug, videoSrc]);

  // 開発用: video の lifecycle 時刻を計測してログ出力する。
  // 本番では isVideoTimingEnabled() が false なので addEventListener しない。
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
          <>
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
            />
            {/*
              中央スライドでまだ <video> が loadeddata / seeked 未到達のときに限り、
              サムネ画像を <video> の上に被せて黒画面を防ぐ。
              - isActive 以外 (隣接スライド): 被せない。隣側で見える予定はないため不要。
              - videoReady=true (すでにフレーム取得済): 被せない。スワイプで中央に
                来た隣接スライドはこのパスでサムネ表示されず、<video> の 1 フレームがそのまま見える。
              - isActive=true かつ videoReady=false: 被せる。cachedSrc 有りでも、
                スワイプ中に見えてしまうとチラつくので isActive 限定。
            */}
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
