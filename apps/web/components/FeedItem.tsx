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
  inspectEntry,
  markStaleClaim,
  pinSlug,
  subscribe as subscribeVideoHandoff,
  unpinSlug,
} from "@/lib/videoHandoff";
import { signalPlaying, signalUnstable } from "@/components/ads/adReadyGate";

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
  // `byte-prefetch promote skipped reason=...` を slug ごとに 1 度だけ出すための ref。
  // 同 effect サイクルで複数回 tryClaim が走っても多重ログを避ける。slug が
  // 変わったら下の slug-change effect でクリアする。
  const claimMissLoggedRef = useRef<string | null>(null);
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
      hasPendingElement(item.slug, videoSrc));
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
      if (!el) {
        // render フェーズで sync 読みした hasPromotableElement と、layout effect 内
        // の claimForFeed の間で entry が消えるレース (TTL / 別 active による
        // markStaleClaim 等)。stale 扱いで host fallback に倒し、永久に
        // thumbnail-cover で stuck するのを防ぐ。
        if (wasPending) unpinSlug(item.slug);
        pendingLoggedRef.current = null;
        markStaleClaim(item.slug, "no-entry");
        setPendingAbandonedSlug(item.slug);
        return false;
      }
      promotedSlugRef.current = item.slug;
      // promote 完了 → pending pin を解除。entry は claimForFeed で registry
      // から消えているので unpinSlug は実質 no-op だが、念のため呼ぶ。
      if (wasPending) unpinSlug(item.slug);
      pendingLoggedRef.current = null;
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
      return false;
    }
    // 該当 entry が registry から消えていた / src 不一致 → 1 度だけ詳細 miss ログを出す。
    // 加えて、prefetch hook 側 (usePrefetchVideoBytes) の active-transition ログが
    // 直後に走る前に markStaleClaim を立て、`byte-prefetched=canplay` と
    // 出ているのに promote 不能だった事実を readiness window が反映できるようにする。
    // FeedItem の useLayoutEffect → usePrefetchVideoBytes の passive useEffect の
    // 順序が保証されているため、ここで mark すれば同 commit で消費される。
    const insp = inspectEntry(item.slug, videoSrc);
    let staleReason: "no-entry" | "src-mismatch" | "not-canplay";
    if (!insp.present) {
      staleReason = "no-entry";
    } else if (!insp.srcMatches) {
      staleReason = "src-mismatch";
    } else {
      staleReason = "not-canplay";
    }
    markStaleClaim(item.slug, staleReason);
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
    } else if (claimMissLoggedRef.current !== item.slug) {
      // pending を経由しなかったケース (例: active 化の瞬間に既に entry が evict
      // 済み / src 不一致) も 1 度だけ詳細ログを残す。これが無いと「prefetch hook
      // 側は canplay と覚えているのに claim path は無言で諦めて JSX <video> を
      // ゼロから立ち上げる」状態を後追いできない。
      claimMissLoggedRef.current = item.slug;
      if (isVideoTimingEnabled()) {
        // claimForFeed の内側で `claim miss reason=...` が出るので、その理由が
        // not-found / src-mismatch / not-canplay のどれかに分かる。
        claimForFeed(item.slug, videoSrc);
        // eslint-disable-next-line no-console
        console.debug(
          `vt byte-prefetch promote skipped slug=${item.slug} reason=${staleReason}`,
        );
      }
    }
    return false;
  }, [isActive, videoSrc, item.slug, pendingAbandonedSlug]);
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
    if (claimMissLoggedRef.current && claimMissLoggedRef.current !== item.slug) {
      claimMissLoggedRef.current = null;
    }
    setPendingAbandonedSlug((prev) => (prev === item.slug ? prev : null));
    activeReadyRef.current = false;
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
    boundElement: promotedElement,
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
    // 旧実装ではここで signalAdsReady() を呼んで広告 gate を解放していたが、
    // canplay は「再生可能」であって「再生が安定している」とは限らない。
    // 4G 等で canplay 直後に waiting / stalled に落ちるケースで広告 provider が
    // 動画の critical path を奪う事故を防ぐため、playing/waiting/stalled の
    // 観測ベースで gate を駆動する (下の playback-stability effect)。
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

  // useFeedPlayback の Phase 2 watchdog (active autoplay stuck) からの救済要求。
  // Phase 1 (load()+play() 直接呼び直し) でも readyState が上がらず paused のままの
  // ケースは、URL 起因 (CDN 署名期限切れ / 接続恒久切断) の可能性が高いので、
  // useResolvedVideoSrc.handleError() を呼んで force re-resolve を起こす。
  // useResolvedVideoSrc.handleError は <video> の onerror からも呼ばれるが、stuck
  // ケースでは error イベントが発火しない (= 単に Range request が永久 pending) ため
  // 明示的なシグナルが必要。
  //
  // 防御層: useFeedPlayback 側の cooldown に加えて FeedItem 側でも cooldown を
  // 持つ。force-resolve は同一 URL に対して何度走っても状態が変わらないケースが
  // あり (新 URL が同 host / 同 CDN 接続不通)、その場合 stuck→force-resolve→
  // stuck の永久ループになる。FeedItem 側 cooldown は「この slug が active で
  // ある間の連続発火」を抑え、上位 (useResolvedVideoSrc) の force retry counter と
  // backoff に処理を委ねる。
  const lastStuckRecoveryRef = useRef<{ slug: string; at: number }>({ slug: "", at: 0 });
  useEffect(() => {
    // active session が切れたら cooldown もリセットする。
    if (!isActive) {
      lastStuckRecoveryRef.current = { slug: "", at: 0 };
    }
  }, [isActive]);
  useEffect(() => {
    if (!isActive) return;
    if (!videoSrc) return;
    const onStuck = (e: Event) => {
      const ce = e as CustomEvent<{ slug?: string }>;
      if (ce.detail?.slug !== item.slug) return;
      const STUCK_RECOVERY_COOLDOWN_MS = 6000;
      const now = Date.now();
      const last = lastStuckRecoveryRef.current;
      if (last.slug === item.slug && now - last.at < STUCK_RECOVERY_COOLDOWN_MS) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${item.slug}: active stuck recovery suppressed reason=cooldown delta=${now - last.at}ms`,
          );
        }
        return;
      }
      lastStuckRecoveryRef.current = { slug: item.slug, at: now };
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${item.slug}: active stuck recovery -> force-resolve`,
        );
      }
      handleError();
    };
    window.addEventListener("video-active-stuck", onStuck);
    return () => {
      window.removeEventListener("video-active-stuck", onStuck);
    };
  }, [isActive, videoSrc, item.slug, handleError]);

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

  // 広告 gate (adReadyGate) を駆動する playback-stability observer。
  //
  // active <video> が playing に入ったら signalPlaying()、waiting / stalled /
  // error / 非 active 化したら signalUnstable() を呼ぶ。gate 側で
  // PLAYBACK_STABLE_MS の安定タイマー + idle callback による flush が行われる。
  //
  // dev-only の timing logger とは独立に常時動かす (本番でも広告 gate は必要)。
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isActive) {
      // 中央から外れた瞬間に走る。flush 予約済みなら gate 側で無視される。
      signalUnstable("inactive");
      return;
    }
    if (!videoSrc) return;
    const video = videoRef.current;
    if (!video) return;

    const onPlaying = () => signalPlaying();
    const onWaiting = () => signalUnstable("waiting");
    const onStalled = () => signalUnstable("stalled");
    const onError = () => signalUnstable("error");

    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onStalled);
    video.addEventListener("error", onError);

    // active 化時点で既に playing 状態 (promoted で readyState>=3 かつ paused=false)
    // なら、playing イベントは発火しない可能性があるため明示的にトリガする。
    if (!video.paused && !video.ended && video.readyState >= 3) {
      signalPlaying();
    }

    return () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onStalled);
      video.removeEventListener("error", onError);
    };
  }, [isActive, videoSrc, videoRef, promotedElement]);

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
