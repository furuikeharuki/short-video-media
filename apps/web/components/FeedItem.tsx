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
  hasPendingElement,
  hasPromotableElement,
  pinSlug,
  subscribe as subscribeVideoHandoff,
  unpinSlug,
} from "@/lib/videoHandoff";
import { getPrefetchPolicy } from "@/lib/networkPrefs";

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

// active 化直後、隠し handoff entry がまだ registry に到達していない可能性がある。
// JSX <video> を即マウントすると別 <video> 要素で新規 GET が走るので、まず短時間
// だけ host placeholder のまま subscribe で claim を待つ。
//
// 120ms は「+1 隣接 <video> が canplay/metadata を発火してプールへ retain される
// までの観測実測値」より少しだけ余裕を見たバジェット。これ以上待つとサムネ
// だけが残って体感的な「動画が起動しない」感が出る。
const HANDOFF_CLAIM_GRACE_MS = 120;

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
  // pending-handoff の状態追跡。
  //  - pendingLoggedRef: `handoff claim pending` ログを slug ごとに 1 回だけ出すため。
  //  - pendingAbandonedSlug (state): pending を諦めた slug。state にすることで
  //    canPromote 再評価による host→JSX <video> フォールバック描画をトリガーする。
  //  - activeReadyRef: 通常 active <video> が canplay/loadeddata 済みかどうか。
  //     true になった後は swap せず pending を `active-playing` で諦める。
  const pendingLoggedRef = useRef<string | null>(null);
  const [pendingAbandonedSlug, setPendingAbandonedSlug] =
    useState<string | null>(null);
  const activeReadyRef = useRef(false);
  // claim grace: active 化時点で handoff entry がまだ registry に無い場合、
  // HANDOFF_CLAIM_GRACE_MS だけ JSX <video> マウントを保留して subscribe で claim を
  // 待つ。grace 中の slug が入っている間は expectingPromotion 扱いし host だけ
  // 描画する。timeout / abandon / promote のいずれかで slug をクリアする。
  const [graceActiveSlug, setGraceActiveSlug] = useState<string | null>(null);
  const graceStartedAtRef = useRef<number>(0);
  // 既に grace を 1 度実施した slug。再 arm 抑止用 (timeout 後の effect 再実行で
  // 無限ループに陥らないため)。slug 変更でリセット。
  const [graceConsumedSlug, setGraceConsumedSlug] = useState<string | null>(null);
  // active へ移行した時点で promotable な隠し要素があれば即時 claim する。
  // hasPromotableElement は registry を sync に読むので render フェーズで判定でき、
  // expectingPromotion=true を渡せば JSX <video> の一時マウントを完全に回避できる。
  // canplay 未到達でも pending entry があれば JSX <video> を作らず host だけを
  // 描画し、subscribe で canplay 到達を待つ (pending promote)。
  const canPromote =
    isActive &&
    !!videoSrc &&
    pendingAbandonedSlug !== item.slug &&
    (hasPromotableElement(item.slug, videoSrc) ||
      hasPendingElement(item.slug, videoSrc) ||
      graceActiveSlug === item.slug);
  const tryClaim = useCallback(() => {
    if (!isActive) return false;
    if (!videoSrc) return false;
    if (promotedSlugRef.current === item.slug) return true;
    if (pendingAbandonedSlug === item.slug) return false;
    // canplay 済み → 即 claim。
    if (hasPromotableElement(item.slug, videoSrc)) {
      const readiness = getReadiness(item.slug) ?? "canplay";
      const wasPending = pendingLoggedRef.current === item.slug;
      const el = claimForFeed(item.slug, videoSrc);
      if (!el) return false;
      promotedSlugRef.current = item.slug;
      // promote 完了 → pending pin を解除。entry は claimForFeed で registry
      // から消えているので unpinSlug は実質 no-op だが、念のため呼ぶ。
      if (wasPending) unpinSlug(item.slug);
      pendingLoggedRef.current = null;
      // grace 中に claim hit したら grace を解除する。
      if (graceActiveSlug === item.slug) {
        if (isVideoTimingEnabled()) {
          const elapsed = Date.now() - graceStartedAtRef.current;
          // eslint-disable-next-line no-console
          console.debug(
            `vt handoff claim grace hit slug=${item.slug} readiness=${readiness} elapsed=${elapsed}ms`,
          );
        }
        setGraceActiveSlug(null);
      }
      setPromotedElement(el);
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt byte-prefetch promote slug=${item.slug} readiness=${readiness}${
            wasPending ? " pending=true" : ""
          }`,
        );
        if (wasPending) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt handoff pending promote slug=${item.slug} readiness=${readiness}`,
          );
        }
      }
      return true;
    }
    // canplay 未到達でも pending entry があれば、subscribe で待つ。
    if (hasPendingElement(item.slug, videoSrc)) {
      // 通常 active <video> が既に再生開始可能なら swap しない方が安全。
      // ここで abandon して subscribe をやめる。
      if (activeReadyRef.current) {
        if (isVideoTimingEnabled()) {
          const readiness = getReadiness(item.slug) ?? "metadata";
          // eslint-disable-next-line no-console
          console.debug(
            `vt handoff pending abandon slug=${item.slug} reason=active-playing readiness=${readiness}`,
          );
        }
        unpinSlug(item.slug);
        pendingLoggedRef.current = null;
        setPendingAbandonedSlug(item.slug);
        return false;
      }
      // pending に入る際は registry 側に pin を立て、cap / TTL クリーンアップで
      // この entry が evict されないようにする。promote または abandon で必ず
      // unpin される。
      const wasAlreadyPending = pendingLoggedRef.current === item.slug;
      const pinned = pinSlug(item.slug, videoSrc);
      if (
        isVideoTimingEnabled() &&
        !wasAlreadyPending
      ) {
        const readiness = getReadiness(item.slug) ?? "metadata";
        // eslint-disable-next-line no-console
        console.debug(
          `vt handoff claim pending slug=${item.slug} readiness=${readiness} pinned=${pinned}`,
        );
      }
      pendingLoggedRef.current = item.slug;
      // pending entry を掴めたので grace は終了 (以降は pending 経路で待つ)。
      if (graceActiveSlug === item.slug) {
        if (isVideoTimingEnabled()) {
          const readiness = getReadiness(item.slug) ?? "metadata";
          const elapsed = Date.now() - graceStartedAtRef.current;
          // eslint-disable-next-line no-console
          console.debug(
            `vt handoff claim grace hit slug=${item.slug} readiness=${readiness} elapsed=${elapsed}ms`,
          );
        }
        setGraceActiveSlug(null);
      }
      return false;
    }
    // 該当 entry が registry から消えていた / src 不一致 → 1 度だけ詳細 miss ログを出す。
    if (pendingLoggedRef.current === item.slug) {
      pendingLoggedRef.current = null;
      unpinSlug(item.slug);
      // claimForFeed が `claim miss reason=not-found|src-mismatch` を出す。
      claimForFeed(item.slug, videoSrc);
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt handoff pending abandon slug=${item.slug} reason=not-found`,
        );
      }
      setPendingAbandonedSlug(item.slug);
    }
    return false;
  }, [isActive, videoSrc, item.slug, pendingAbandonedSlug, graceActiveSlug]);
  // active 化 / videoSrc 解決のタイミングでまず claim を試す。
  // useLayoutEffect は passive useEffect より前に走るので、隣接 PrefetchVideoBuffer
  // の cleanup (releasePrefetchElement) より先に claim を取れる。
  useLayoutEffect(() => {
    tryClaim();
  }, [tryClaim]);
  // canplay 到達が active 化より遅れる場合 (resolve 中 / pending 中) に備え、
  // registry の状態変化を購読して claim を再試行する。
  // promote 済み or 非 active なら no-op。
  useEffect(() => {
    if (!isActive) return;
    if (promotedSlugRef.current === item.slug) return;
    if (!videoSrc) return;
    const unsub = subscribeVideoHandoff(() => {
      tryClaim();
    });
    return unsub;
  }, [isActive, videoSrc, item.slug, tryClaim]);
  // claim grace: active 化時点で handoff entry がまだ registry に到達していない
  // ケースに備えて、JSX <video> マウントを HANDOFF_CLAIM_GRACE_MS だけ保留する。
  // 既に promotable / pending entry があればそちらの経路で処理されるので grace
  // 不要。Save-Data / 2g の様に prefetch 自体が動かない環境 (aheadCount=0) では
  // 同期的に判別できるので grace をスキップしてすぐ JSX <video> をマウントする。
  useEffect(() => {
    if (!isActive) return;
    if (!videoSrc) return;
    if (promotedSlugRef.current === item.slug) return;
    if (pendingAbandonedSlug === item.slug) return;
    // 既に claim 可能 / pending が掴めるなら grace 不要 (subscribe / immediate claim で処理)。
    if (hasPromotableElement(item.slug, videoSrc)) return;
    if (hasPendingElement(item.slug, videoSrc)) return;
    // 先読みが完全に無効な環境では handoff entry が永久に来ない → grace スキップ。
    try {
      if (getPrefetchPolicy().aheadCount === 0) return;
    } catch {
      // 何かおかしくても安全側 (= grace を張る) に倒す。
    }
    if (graceActiveSlug === item.slug) return;
    if (graceConsumedSlug === item.slug) return;
    graceStartedAtRef.current = Date.now();
    setGraceActiveSlug(item.slug);
    if (isVideoTimingEnabled()) {
      // eslint-disable-next-line no-console
      console.debug(
        `vt handoff claim grace start slug=${item.slug} timeout=${HANDOFF_CLAIM_GRACE_MS}ms`,
      );
    }
    const slug = item.slug;
    const timer = setTimeout(() => {
      // タイムアウト時点でもう一度 claim を試す。それでもダメなら諦めて
      // JSX <video> を mount させる。
      const claimed = tryClaim();
      if (claimed) return;
      if (isVideoTimingEnabled()) {
        const elapsed = Date.now() - graceStartedAtRef.current;
        // eslint-disable-next-line no-console
        console.debug(
          `vt handoff claim grace timeout slug=${slug} elapsed=${elapsed}ms`,
        );
      }
      setGraceConsumedSlug(slug);
      setGraceActiveSlug((prev) => (prev === slug ? null : prev));
    }, HANDOFF_CLAIM_GRACE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [
    isActive,
    videoSrc,
    item.slug,
    pendingAbandonedSlug,
    graceActiveSlug,
    graceConsumedSlug,
    tryClaim,
  ]);
  // slug 変更で promoted / pending 状態を捨てる (別作品にスワイプして戻ってきた等)。
  useEffect(() => {
    if (promotedSlugRef.current && promotedSlugRef.current !== item.slug) {
      promotedSlugRef.current = null;
      setPromotedElement(null);
    }
    if (
      pendingLoggedRef.current &&
      pendingLoggedRef.current !== item.slug
    ) {
      // 別 slug を pending pin していたなら確実に解除する。
      unpinSlug(pendingLoggedRef.current);
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt handoff pending abandon slug=${pendingLoggedRef.current} reason=slug-changed`,
        );
      }
    }
    pendingLoggedRef.current = null;
    setPendingAbandonedSlug((prev) => (prev === item.slug ? prev : null));
    activeReadyRef.current = false;
    // slug が変わったら前の grace は無効化する。新 slug 用 grace は別 effect で
    // 再 arm される。
    setGraceActiveSlug((prev) => (prev === item.slug ? prev : null));
    setGraceConsumedSlug((prev) => (prev === item.slug ? prev : null));
  }, [item.slug]);
  // アンマウント / 非 active 化で残った pending pin を解除する。
  // pinned entry を解放しないと、別ユーザー操作で同 slug が active になるまで
  // pool に居座り続けて cap を圧迫する。
  useEffect(() => {
    if (isActive) return;
    if (pendingLoggedRef.current === item.slug) {
      unpinSlug(item.slug);
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt handoff pending abandon slug=${item.slug} reason=inactive`,
        );
      }
      pendingLoggedRef.current = null;
    }
    // 非 active になったら待機中の grace も解除。
    setGraceActiveSlug((prev) => (prev === item.slug ? null : prev));
  }, [isActive, item.slug]);
  useEffect(() => {
    return () => {
      if (pendingLoggedRef.current) {
        unpinSlug(pendingLoggedRef.current);
        pendingLoggedRef.current = null;
      }
    };
  }, []);

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

  const abandonPendingIfActiveReady = useCallback(() => {
    if (pendingLoggedRef.current !== item.slug) return;
    unpinSlug(item.slug);
    if (isVideoTimingEnabled()) {
      const readiness = getReadiness(item.slug) ?? "metadata";
      // eslint-disable-next-line no-console
      console.debug(
        `vt handoff pending abandon slug=${item.slug} reason=active-playing readiness=${readiness}`,
      );
    }
    pendingLoggedRef.current = null;
    setPendingAbandonedSlug(item.slug);
  }, [item.slug]);

  const handleLoadedData = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    activeReadyRef.current = true;
    abandonPendingIfActiveReady();
    setVideoReady(true);
    setVideoReadyState(true);
    setSpinnerVisible(false);
    setShimmerVisible(false);
  }, [setVideoReady, setSpinnerVisible, setShimmerVisible, clearHardTimeout, abandonPendingIfActiveReady]);

  const handleCanPlay = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    activeReadyRef.current = true;
    abandonPendingIfActiveReady();
    setVideoReady(true);
    setVideoReadyState(true);
    setSpinnerVisible(false);
    setShimmerVisible(false);
  }, [setVideoReady, setSpinnerVisible, setShimmerVisible, clearHardTimeout, abandonPendingIfActiveReady]);

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
    activeReadyRef.current = false;
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
