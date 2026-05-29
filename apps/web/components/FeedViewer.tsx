"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FeedItem from "@/components/FeedItem";
import FeedAdSlide from "@/components/ads/FeedAdSlide";
import type { MovieCard } from "@/lib/api/feed";
import { markFeedGesture } from "@/components/feed/useFeedPlayback";
import { usePrefetchResolveMp4 } from "@/components/feed/usePrefetchResolveMp4";
import { usePrefetchVideoBytes } from "@/components/feed/usePrefetchVideoBytes";
import { useWarmResolveMp4 } from "@/components/feed/useWarmResolveMp4";
import PrefetchVideoBuffer from "@/components/feed/PrefetchVideoBuffer";
import { AD_FEED_INTERVAL, isAdZoneEnabled } from "@/lib/ads/config";

const WINDOW_SIZE = 1;
const RAPID_THRESHOLD_MS = 350;
// 高速スワイプ判定が静まるまでの時間 (ms)。この間、隣接スライドの preload は
// "metadata" に弱められ、active <video> の Range request が帯域を独占できる。
// 旧値 350ms は active が rs=1 (loadedmetadata) に達する前に "auto" に戻り、
// 隣接 <video preload="auto"> が active の Range を奪うケースが観測されたため、
// active 安定までを概ねカバーする 900ms まで延長する。これより長くしすぎると
// ゆっくりスワイプでも next slide が温まらず最初の再生開始で待たされるため、
// 短期 prefetch との両立点として 900ms を採用。
const RAPID_SETTLE_MS = 900;

// BottomNav の高さ。タッチ終端がここより下なら BottomNav 操作として扱う。
const BOTTOM_NAV_H = 56;

/**
 * スワイプと確定するまでの縦移動量のしきい値 (px)。
 * この距離以上動いて初めて縦スクロール抑止 (preventDefault) を呼ぶ。
 * それ未満の移動量（タップ）では呼ばず、ブラウザの click イベント発火を妨げない。
 *
 * SWIPE_COMMIT_DISTANCE (1px) と同値まで下げる。これにより 1px 以上の指の
 * 移動でロックが立ち、コミット判定に到達できる。タップ時の指ブレで誤発火
 * しやすくなるトレードオフはあるが、ユーザ要望に従いここまで詰める。
 */
const SWIPE_LOCK_THRESHOLD = 1;

/**
 * touchend で「スワイプとして次/前の動画に進む」と判定する縦移動量 (px) と
 * 最大経過時間 (ms)。値が大きいほど厳しく (スワイプしにくく) なる。
 *
 * 以前は 60px / 1000ms → 40px / 1500ms → 20px → 5px と緩和してきたが、
 * さらに反応をよくして欲しいという要望があり、距離を 1px まで詰める。
 * 比較は `>=` で行うため、「1px 以上の移動」でコミットされる
 * (`>` だと 1px ちょうどでは確定せず snapback してしまい、PR #159 の
 * 「1px 以上で進む」という意図と食い違っていた)。
 * 指のごく僅かなブレでもスワイプ確定するため、タップとの取り違えが
 * 起きやすくなる点には注意。SWIPE_LOCK_THRESHOLD (1px) と同値にすることで
 * ロックを立ててからコミット判定に到達する経路は維持している。
 */
const SWIPE_COMMIT_DISTANCE = 1;
const SWIPE_COMMIT_MAX_MS   = 1500;

/**
 * touchstart の target がテキスト入力系の要素 (input / textarea / contenteditable
 * / select) の場合は、FeedViewer のスワイプロジックを走らせない。
 * これらの要素はテキスト選択 / 文字入力のためにタッチを内部で消費しており、
 * 親側で preventDefault するとキャレット移動などができなくなる。
 *
 * 注: ボタン / リンク (button, a, role="button"/"link") は **除外しない**。
 *     ジャンル chip や side-actions のボタンの上から始まったスワイプも
 *     上下方向にしきい値 (SWIPE_LOCK_THRESHOLD) を超えれば通常のフィード
 *     スワイプとして扱う。タップ (しきい値未満) は preventDefault しないので
 *     ブラウザが click を発火させて従来通り動作する。
 */
function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(
    'input, textarea, select, [contenteditable="true"]',
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

  // currentIndex は slides 配列の index (広告スライドを含む)。一方 prefetch hook 群は
  // 動画のみで構成された movieItems を受け取るので、両者の index を直接突き合わせると
  // 広告挿入後にズレる (例: AD_FEED_INTERVAL=10 で 11 番目のスライドが広告のとき、
  // それ以降 movieItems[currentIndex] は実際に再生中の動画と別作品を指す)。
  // この乖離は vt ログで `byte-prefetch active index=N slug=A` と
  // `active autoplay start slug=B` が同時に出るという形で観測されていた
  // (current prewarm が違う作品を温め、active <video> はゼロからロードする状態)。
  // 解決: 「アクティブスライドが動画ならその videoIndex」「広告なら次に来る動画の
  // videoIndex (= 直前の videoCount)」を currentVideoIndex として渡す。これにより
  // movieItems[currentVideoIndex] は常に「次に再生される動画」と一致する。
  const activeSlide = slides[currentIndex];
  const currentVideoIndex =
    activeSlide?.kind === "video"
      ? activeSlide.videoIndex
      : slides
          .slice(0, currentIndex + 1)
          .filter((s): s is Extract<FeedSlide, { kind: "video" }> => s.kind === "video")
          .length;

  usePrefetchResolveMp4(movieItems, currentVideoIndex, isRapidSwiping);
  // 遠距離 (current+6..+15) を低優先度でバックグラウンド resolve。
  // 近距離 prefetch / active と同じ resolveCache を共有するので、ユーザーが
  // そこに到達するまでに URL が温まっている確率を上げる。
  useWarmResolveMp4(movieItems, currentVideoIndex, isRapidSwiping);
  const {
    slots: prefetchSlots,
    handleSlotError,
    handleSlotMetadata,
    handleSlotCanPlay,
  } = usePrefetchVideoBytes(movieItems, currentVideoIndex, isRapidSwiping);

  const [dragPx, setDragPx] = useState(0);
  const dragStartY         = useRef(0);
  const dragStartYForEnd   = useRef(0);
  const dragStartTime      = useRef(0);
  const isDragging         = useRef(false);
  /** BottomNav 上で始まったタッチ → スワイプ処理・preventDefault をスキップ */
  const touchStartedInNavRef  = useRef(false);
  /**
   * テキスト入力系 (input / textarea / contenteditable / select) 上で始まった
   * タッチ → スワイプ判定を走らせない (キャレット移動などを妨げないため)。
   * ボタン / リンクはここに含めない (それらはタップ閾値で自動判別する)。
   */
  const touchStartedOnTextInputRef = useRef(false);
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
        touchStartedOnTextInputRef.current = false;
        return;
      }
      // テキスト入力系の要素 (input / textarea / contenteditable / select) 上で
      // 始まったタッチはスワイプ判定を一切走らせない (キャレット移動 / 文字選択
      // を妨げないため)。
      // ボタン / リンク / chip 等はここで bail せず通常の swipe 経路に乗せる。
      // しきい値 (SWIPE_LOCK_THRESHOLD = 1px) 未満ならタップとしてブラウザの
      // synthetic click が発火するし、超えたら preventDefault してフィード
      // スワイプとして扱う。
      if (isTextInputTarget(e.target)) {
        touchStartedOnTextInputRef.current = true;
        touchStartedInNavRef.current = false;
        return;
      }
      touchStartedOnTextInputRef.current = false;
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
      if (touchStartedOnTextInputRef.current) return;
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
      if (touchStartedOnTextInputRef.current) {
        touchStartedOnTextInputRef.current = false;
        return;
      }
      if (!isDragging.current) return;
      isDragging.current = false;
      swipeLockedRef.current = false;
      setDragPx(0);
      const dy = e.changedTouches[0].clientY - dragStartYForEnd.current;
      const dt = Date.now() - dragStartTime.current;
      if (Math.abs(dy) >= SWIPE_COMMIT_DISTANCE && dt < SWIPE_COMMIT_MAX_MS) { if (dy < 0) goNext(); else goPrev(); }
    };

    const onTouchCancel = () => {
      isDragging.current = false;
      swipeLockedRef.current = false;
      touchStartedInNavRef.current = false;
      touchStartedOnTextInputRef.current = false;
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
      touchStartedOnTextInputRef.current = false;
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
      {prefetchSlots.map((slot) => {
        // rapid swipe 中は +2 以降を弱めて中央 <video> の帯域を温存するが、
        // +1 だけは「次に確実に表示される」スロットなので slot.preload をそのまま使い、
        // Chrome ではバイトを取りに行かせる (Safari policy は metadata のまま)。
        const preload =
          isRapidSwiping && slot.offset > 1 ? "metadata" : slot.preload;
        return (
          <PrefetchVideoBuffer
            key={slot.id}
            slug={slot.slug}
            src={slot.src}
            preload={preload}
            offset={slot.offset}
            minStart={slot.minStart}
            onError={handleSlotError}
            onMetadata={handleSlotMetadata}
            onCanPlay={handleSlotCanPlay}
          />
        );
      })}
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
