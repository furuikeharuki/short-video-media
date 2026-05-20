"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FeedItem from "@/components/FeedItem";
import FeedAdSlide from "@/components/ads/FeedAdSlide";
import type { MovieCard } from "@/lib/api/feed";
import { markFeedGesture } from "@/components/feed/useFeedPlayback";
import { usePrefetchResolveMp4 } from "@/components/feed/usePrefetchResolveMp4";
import { usePrefetchVideoBytes } from "@/components/feed/usePrefetchVideoBytes";
import PrefetchVideoBuffer from "@/components/feed/PrefetchVideoBuffer";
import { AD_FEED_INTERVAL, isAdZoneEnabled } from "@/lib/ads/config";

const WINDOW_SIZE = 1;
const RAPID_THRESHOLD_MS = 350;
const RAPID_SETTLE_MS = 350;

// BottomNav の高さ。タッチ終端がここより下なら BottomNav 操作として扱う。
const BOTTOM_NAV_H = 56;

/**
 * スワイプと確定するまでの縦移動量のしきい値 (px)。
 * この距離を超えて初めて縦スクロール抑止 (preventDefault) を呼ぶ。
 * それ未満の移動量（タップ）では呼ばず、ブラウザの click イベント発火を妨げない。
 *
 * 8px だと小さなジャンル chip や検索アイコン等のタップ中に指のわずかな
 * ぶれで簡単に超えてしまい preventDefault が走り synthetic click が消える。
 * 16px なら明確なスワイプとタップを区別しつつ、タップの指ブレは吸収できる。
 */
const SWIPE_LOCK_THRESHOLD = 16;

/**
 * touchstart の target がインタラクティブな要素 (ボタン / リンク / 入力欄など)
 * の場合は、FeedViewer のスワイプロジックを一切走らせない。
 * これにより、ジャンル chip や side-actions ボタン、フィード内に重ねた他の
 * インタラクティブ要素のタップが「指ブレ → preventDefault → click 消失」で
 * 失敗するのを完全に防ぐ。
 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // closest で祖先 (たとえば <button> 内の <svg>) も拾う
  return !!target.closest(
    'button, a, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]',
  );
}

type FeedSlide =
  | { kind: "video"; movie: MovieCard; videoIndex: number }
  | { kind: "ad"; adIndex: number; key: string };

function appendSlides(
  prev: FeedSlide[],
  newMovies: MovieCard[],
  interval: number,
  adEnabled: boolean,
): FeedSlide[] {
  if (newMovies.length === 0) return prev;
  let videoCount = prev.filter(s => s.kind === "video").length;
  let adCount    = prev.filter(s => s.kind === "ad").length;
  const added: FeedSlide[] = [];
  for (const movie of newMovies) {
    added.push({ kind: "video", movie, videoIndex: videoCount });
    videoCount++;
    if (adEnabled && interval > 0 && videoCount % interval === 0) {
      added.push({ kind: "ad", adIndex: adCount, key: `ad-${adCount}` });
      adCount++;
    }
  }
  return [...prev, ...added];
}

function isTouchInBottomNav(clientY: number): boolean {
  return clientY >= window.innerHeight - BOTTOM_NAV_H;
}

interface Props {
  items: MovieCard[];
  initialIndex?: number;
  onNearEnd?: (currentIndex: number) => void;
  onIndexChange?: (index: number) => void;
}

export default function FeedViewer({
  items,
  initialIndex = 0,
  onNearEnd,
  onIndexChange,
}: Props) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const currentIdxRef = useRef(0);
  const wheelLockRef  = useRef(false);
  const modalOpenRef  = useRef(false);

  const adEnabled = isAdZoneEnabled("mobileBanner300x250") && AD_FEED_INTERVAL > 0;

  const [currentIndex, setCurrentIndex] = useState(0);
  const [slides, setSlides] = useState<FeedSlide[]>([]);
  const [windowSlides, setWindowSlides] = useState<FeedSlide[]>([]);
  const windowStartRef = useRef(0);
  const prevItemsLenRef = useRef(0);

  const [isRapidSwiping, setIsRapidSwiping] = useState(false);
  const lastIndexChangeRef = useRef(0);
  const rapidSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const movieItems = slides
    .filter((s): s is Extract<FeedSlide, { kind: "video" }> => s.kind === "video")
    .map((s) => s.movie);

  usePrefetchResolveMp4(movieItems, currentIndex, isRapidSwiping);
  const { slots: prefetchSlots, handleSlotError } = usePrefetchVideoBytes(
    movieItems,
    currentIndex,
    isRapidSwiping,
  );

  const [dragPx, setDragPx] = useState(0);
  const dragStartY         = useRef(0);
  const dragStartYForEnd   = useRef(0);
  const dragStartTime      = useRef(0);
  const isDragging         = useRef(false);
  /** BottomNav 上で始まったタッチ → スワイプ処理・preventDefault をスキップ */
  const touchStartedInNavRef  = useRef(false);
  /** ジャンル chip 等のインタラクティブ要素上で始まったタッチ → スワイプを乗っ取らない */
  const touchStartedOnInteractiveRef = useRef(false);
  /** touchmove で一度でも SWIPE_LOCK_THRESHOLD を超えたか */
  const swipeLockedRef        = useRef(false);
  /**
   * `slides.length` を ref で持つ。touch listener の effect から slides を依存に
   * 取ると、fetchMore で setSlides されるたびに addEventListener / removeEventListener
   * が走り、もしユーザが進行中のスワイプを持っていたとき touchend が新旧どちらの
   * リスナーで処理されるか不安定になって「下に進めなくなる」状態になる。
   * ref 化することで listener は一度しか attach せず、最新値だけ参照する。
   */
  const slidesLengthRef = useRef(0);
  /**
   * 「現在 slides の最後にいる + ユーザは下に進みたい」状態を覚えておくフラグ。
   * 厳しいフィルター (例: ジャンル 2 つ AND) で 1 ページあたりの結果が少ないと、
   * 高速スワイプで末尾に到達した瞬間に fetchMore がまだ返っておらず goNext が
   * silent no-op (\`nextIdx >= prevSlides.length\`) になる。
   * これを true にしておけば、items が伸びて新しい slide が追加された直後に
   * 自動で goNext を 1 回だけ走らせ、ユーザのスワイプ意図を取りこぼさない。
   */
  const pendingNextRef = useRef(false);

  // touch listener が参照するための ref を毎レンダー同期 (再 attach しないため)
  slidesLengthRef.current = slides.length;

  useEffect(() => {
    const now = Date.now();
    const sinceLast = now - lastIndexChangeRef.current;
    lastIndexChangeRef.current = now;
    if (sinceLast < RAPID_THRESHOLD_MS) setIsRapidSwiping(true);
    if (rapidSettleTimerRef.current) clearTimeout(rapidSettleTimerRef.current);
    rapidSettleTimerRef.current = setTimeout(() => {
      setIsRapidSwiping(false);
      rapidSettleTimerRef.current = null;
    }, RAPID_SETTLE_MS);
    return () => {
      if (rapidSettleTimerRef.current) clearTimeout(rapidSettleTimerRef.current);
    };
  }, [currentIndex]);

  useEffect(() => {
    const onOpen  = () => { modalOpenRef.current = true; };
    const onClose = () => { modalOpenRef.current = false; };
    window.addEventListener("modal-open",  onOpen);
    window.addEventListener("modal-close", onClose);
    return () => {
      window.removeEventListener("modal-open",  onOpen);
      window.removeEventListener("modal-close", onClose);
    };
  }, []);

  const updateWindow = useCallback((idx: number, allSlides: FeedSlide[]) => {
    const start = Math.max(0, idx - WINDOW_SIZE);
    const end   = Math.min(allSlides.length, idx + WINDOW_SIZE + 1);
    windowStartRef.current = start;
    setWindowSlides(allSlides.slice(start, end));
  }, []);

  const didInitRef = useRef(false);
  useEffect(() => {
    if (!didInitRef.current) {
      didInitRef.current = true;
      prevItemsLenRef.current = items.length;
      const newSlides = appendSlides([], items, AD_FEED_INTERVAL, adEnabled);
      setSlides(newSlides);
      // initialIndex は items (動画) ベースの index。slides は ads が間に挟まるため
      // 該当する videoIndex を持つ slide を探してその位置から再生開始する。
      const clampedVideoIdx = Math.min(
        Math.max(initialIndex, 0),
        Math.max(items.length - 1, 0),
      );
      const slideIdx = newSlides.findIndex(
        (s) => s.kind === "video" && s.videoIndex === clampedVideoIdx,
      );
      const startIdx = slideIdx >= 0 ? slideIdx : 0;
      currentIdxRef.current = startIdx;
      setCurrentIndex(startIdx);
      updateWindow(startIdx, newSlides);
      if (newSlides.length > 0 && items.length - clampedVideoIdx <= 5) {
        onNearEnd?.(startIdx);
      }
      return;
    }
    const prevLen = prevItemsLenRef.current;
    if (items.length <= prevLen) return;
    prevItemsLenRef.current = items.length;
    const newMovies = items.slice(prevLen);
    setSlides((prev) => {
      const next = appendSlides(prev, newMovies, AD_FEED_INTERVAL, adEnabled);
      const clamped = Math.min(currentIdxRef.current, next.length - 1);
      updateWindow(clamped, next);
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const goNext = useCallback(() => {
    setSlides((prevSlides) => {
      const nextIdx = currentIdxRef.current + 1;
      if (nextIdx >= prevSlides.length) {
        // 末尾到達: fetchMore がまだ走っていない可能性があるので明示的にキック。
        // さらに「下に進みたい意図」を覚えておき、新しい slide が来た瞬間に自動で
        // 1 段だけ進めるようにする (restrictive filter で fetchMore が遅れた時の救済)。
        pendingNextRef.current = true;
        onNearEnd?.(currentIdxRef.current);
        return prevSlides;
      }
      markFeedGesture();
      pendingNextRef.current = false;
      currentIdxRef.current = nextIdx;
      setCurrentIndex(nextIdx);
      updateWindow(nextIdx, prevSlides);
      onIndexChange?.(nextIdx);
      const movieCount = prevSlides.filter(s => s.kind === "video").length;
      const passedMovies = prevSlides
        .slice(0, nextIdx + 1)
        .filter(s => s.kind === "video").length;
      if (movieCount - passedMovies <= 5) onNearEnd?.(nextIdx);
      return prevSlides;
    });
  }, [updateWindow, onNearEnd, onIndexChange]);

  const goPrev = useCallback(() => {
    const next = Math.max(0, currentIdxRef.current - 1);
    if (next === currentIdxRef.current) return;
    markFeedGesture();
    // 上に戻る操作をしたら "進みたい意図" は破棄する
    pendingNextRef.current = false;
    currentIdxRef.current = next;
    setCurrentIndex(next);
    setSlides((prev) => { updateWindow(next, prev); return prev; });
    onIndexChange?.(next);
  }, [updateWindow, onIndexChange]);

  // 末尾で goNext を空振りした (pendingNextRef === true) ときに、新しい slide が
  // 追加されたら自動で 1 段だけ進める。これにより
  // 「ジャンル 2 つ等で結果が少なめのフィード × 高速スワイプ」の場面でも
  // ユーザのスワイプ意図が取り残されない。
  useEffect(() => {
    if (!pendingNextRef.current) return;
    if (slides.length <= currentIdxRef.current + 1) return;
    pendingNextRef.current = false;
    goNext();
  }, [slides.length, goNext]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      if (modalOpenRef.current) return;
      const startY = e.touches[0].clientY;
      if (isTouchInBottomNav(startY)) {
        touchStartedInNavRef.current = true;
        touchStartedOnInteractiveRef.current = false;
        return;
      }
      // ジャンル chip / side-actions / 詳細ボタン等のインタラクティブ要素上で
      // 始まったタッチは、スワイプ判定を一切走らせない (preventDefault しない)。
      // これにより指のわずかなブレで click が消えるのを防ぐ。
      if (isInteractiveTarget(e.target)) {
        touchStartedOnInteractiveRef.current = true;
        touchStartedInNavRef.current = false;
        return;
      }
      touchStartedOnInteractiveRef.current = false;
      touchStartedInNavRef.current = false;
      swipeLockedRef.current = false;
      isDragging.current = true;
      dragStartY.current = startY;
      dragStartYForEnd.current = startY;
      dragStartTime.current = Date.now();
      setDragPx(0);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (modalOpenRef.current) return;
      if (touchStartedInNavRef.current) return;
      if (touchStartedOnInteractiveRef.current) return;
      if (!isDragging.current) return;

      const dy = e.touches[0].clientY - dragStartY.current;

      // SWIPE_LOCK_THRESHOLD を超えて初めてスクロール抑止する。
      // それ未満（タップ）では preventDefault を呼ばずブラウザの click を生かす。
      if (!swipeLockedRef.current) {
        if (Math.abs(dy) < SWIPE_LOCK_THRESHOLD) return;
        swipeLockedRef.current = true;
      }
      e.preventDefault();

      const atEnd = currentIdxRef.current >= slidesLengthRef.current - 1;
      const atTop = currentIdxRef.current <= 0;
      setDragPx((dy > 0 && atTop) || (dy < 0 && atEnd) ? dy * 0.35 : dy);
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (modalOpenRef.current) { isDragging.current = false; return; }
      if (touchStartedInNavRef.current) {
        touchStartedInNavRef.current = false;
        return;
      }
      if (touchStartedOnInteractiveRef.current) {
        touchStartedOnInteractiveRef.current = false;
        return;
      }
      if (!isDragging.current) return;
      isDragging.current = false;
      swipeLockedRef.current = false;
      setDragPx(0);
      const dy = e.changedTouches[0].clientY - dragStartYForEnd.current;
      const dt = Date.now() - dragStartTime.current;
      if (Math.abs(dy) > 60 && dt < 1000) { if (dy < 0) goNext(); else goPrev(); }
    };

    const onTouchCancel = () => {
      isDragging.current = false;
      swipeLockedRef.current = false;
      touchStartedInNavRef.current = false;
      touchStartedOnInteractiveRef.current = false;
      setDragPx(0);
    };

    const onWheel = (e: WheelEvent) => {
      if (modalOpenRef.current) return;
      e.preventDefault();
      if (wheelLockRef.current) return;
      wheelLockRef.current = true;
      setTimeout(() => { wheelLockRef.current = false; }, 300);
      if (e.deltaY > 0) goNext(); else goPrev();
    };

    // タブ切り替え / 戻る / 別ページ遷移 等でジェスチャ refs が "進行中" の
    // まま残ると、復帰後の最初のスワイプが効かない/方向が反転する症状になる。
    // visibilitychange と pagehide で確実にリセットする。
    const resetGesture = () => {
      isDragging.current = false;
      swipeLockedRef.current = false;
      touchStartedInNavRef.current = false;
      touchStartedOnInteractiveRef.current = false;
      wheelLockRef.current = false;
      pendingNextRef.current = false;
      setDragPx(0);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") resetGesture();
    };

    el.addEventListener("touchstart",  onTouchStart,  { passive: true });
    el.addEventListener("touchmove",   onTouchMove,   { passive: false });
    el.addEventListener("touchend",    onTouchEnd,    { passive: true });
    el.addEventListener("touchcancel", onTouchCancel, { passive: true });
    el.addEventListener("wheel",       onWheel,       { passive: false });
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", resetGesture);
    return () => {
      el.removeEventListener("touchstart",  onTouchStart);
      el.removeEventListener("touchmove",   onTouchMove);
      el.removeEventListener("touchend",    onTouchEnd);
      el.removeEventListener("touchcancel", onTouchCancel);
      el.removeEventListener("wheel",       onWheel);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", resetGesture);
    };
    // touch listener は一度だけ attach する。slides の変化は slidesLengthRef で吸収。
    // goNext / goPrev も useCallback で安定参照だが、念のためデップに含める。
  }, [goNext, goPrev]);

  return (
    <div ref={containerRef} className="feed-container">
      {prefetchSlots.map((slot) => (
        <PrefetchVideoBuffer
          key={slot.id}
          slug={slot.slug}
          src={slot.src}
          preload={isRapidSwiping ? "metadata" : "auto"}
          onError={handleSlotError}
        />
      ))}
      {windowSlides.map((slide, i) => {
        const absIndex = windowStartRef.current + i;
        const offset   = absIndex - currentIndex;
        const isActive = offset === 0;
        const transform  = `translateY(calc(${offset * 100}% + ${dragPx}px))`;
        const transition = dragPx !== 0 ? "none" : "transform 0.35s cubic-bezier(0.25,1,0.5,1)";

        if (slide.kind === "ad") {
          return (
            <div
              key={slide.key}
              className="feed-slide"
              style={{ transform, transition, zIndex: isActive ? 2 : 1, pointerEvents: isActive ? "auto" : "none" }}
            >
              <FeedAdSlide adIndex={slide.adIndex} isActive={isActive} />
            </div>
          );
        }

        return (
          <div
            key={slide.movie.id}
            className="feed-slide"
            style={{ transform, transition, zIndex: isActive ? 2 : 1, pointerEvents: isActive ? "auto" : "none" }}
          >
            <FeedItem
              item={slide.movie}
              isActive={isActive}
              isAdjacent={Math.abs(offset) === 1}
              isFirst={slide.videoIndex === 0}
              isSecond={slide.videoIndex === 1}
              isRapidSwiping={isRapidSwiping}
            />
          </div>
        );
      })}
    </div>
  );
}
