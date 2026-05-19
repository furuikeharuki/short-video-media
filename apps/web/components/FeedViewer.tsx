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

type FeedSlide =
  | { kind: "video"; movie: MovieCard; videoIndex: number }
  | { kind: "ad"; adIndex: number };

function buildSlides(movies: MovieCard[], interval: number, adEnabled: boolean): FeedSlide[] {
  if (!adEnabled || interval <= 0) {
    return movies.map((m, i) => ({ kind: "video", movie: m, videoIndex: i }));
  }
  const slides: FeedSlide[] = [];
  let adIndex = 0;
  movies.forEach((m, i) => {
    slides.push({ kind: "video", movie: m, videoIndex: i });
    if ((i + 1) % interval === 0 && i < movies.length - 1) {
      slides.push({ kind: "ad", adIndex: adIndex++ });
    }
  });
  return slides;
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

  const adEnabled = isAdZoneEnabled("feedNative") && AD_FEED_INTERVAL > 0;

  const [currentIndex, setCurrentIndex] = useState(0);
  const [slides, setSlides] = useState<FeedSlide[]>([]);
  const [windowSlides, setWindowSlides] = useState<FeedSlide[]>([]);
  const windowStartRef = useRef(0);

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

  const [dragPx,         setDragPx]       = useState(0);
  const dragStartY       = useRef(0);
  const dragStartYForEnd = useRef(0);
  const dragStartTime    = useRef(0);
  const isDragging       = useRef(false);

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
    const newSlides = buildSlides(items, AD_FEED_INTERVAL, adEnabled);
    setSlides(newSlides);
    if (didInitRef.current) {
      const clamped = Math.min(currentIdxRef.current, Math.max(0, newSlides.length - 1));
      if (clamped !== currentIdxRef.current) {
        currentIdxRef.current = clamped;
        setCurrentIndex(clamped);
      }
      updateWindow(clamped, newSlides);
      return;
    }
    didInitRef.current = true;
    const startIdx = 0;
    currentIdxRef.current = startIdx;
    setCurrentIndex(startIdx);
    updateWindow(startIdx, newSlides);
    if (newSlides.length > 0 && newSlides.length - startIdx <= 5) {
      onNearEnd?.(startIdx);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const goNext = useCallback(() => {
    setSlides((prevSlides) => {
      const nextIdx = currentIdxRef.current + 1;
      if (nextIdx >= prevSlides.length) return prevSlides;
      markFeedGesture();
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
    currentIdxRef.current = next;
    setCurrentIndex(next);
    setSlides((prev) => { updateWindow(next, prev); return prev; });
    onIndexChange?.(next);
  }, [updateWindow, onIndexChange]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onTouchStart = (e: TouchEvent) => {
      if (modalOpenRef.current) return;
      const y = e.touches[0].clientY;
      isDragging.current = true;
      dragStartY.current = y;
      dragStartYForEnd.current = y;
      dragStartTime.current = Date.now();
      setDragPx(0);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (modalOpenRef.current) return;
      e.preventDefault();
      if (!isDragging.current) return;
      const dy   = e.touches[0].clientY - dragStartY.current;
      const atEnd = currentIdxRef.current >= slides.length - 1;
      const atTop = currentIdxRef.current <= 0;
      if ((dy > 0 && atTop) || (dy < 0 && atEnd)) {
        setDragPx(dy * 0.35);
      } else {
        setDragPx(dy);
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (modalOpenRef.current) { isDragging.current = false; return; }
      if (!isDragging.current) return;
      isDragging.current = false;
      setDragPx(0);
      const dy = e.changedTouches[0].clientY - dragStartYForEnd.current;
      const dt = Date.now() - dragStartTime.current;
      if (Math.abs(dy) > 60 && dt < 1000) {
        if (dy < 0) goNext(); else goPrev();
      }
    };
    const onTouchCancel = () => { isDragging.current = false; setDragPx(0); };
    const onWheel = (e: WheelEvent) => {
      if (modalOpenRef.current) return;
      e.preventDefault();
      if (wheelLockRef.current) return;
      wheelLockRef.current = true;
      setTimeout(() => { wheelLockRef.current = false; }, 300);
      if (e.deltaY > 0) goNext(); else goPrev();
    };
    el.addEventListener("touchstart",  onTouchStart,  { passive: true });
    el.addEventListener("touchmove",   onTouchMove,   { passive: false });
    el.addEventListener("touchend",    onTouchEnd,    { passive: true });
    el.addEventListener("touchcancel", onTouchCancel, { passive: true });
    el.addEventListener("wheel",       onWheel,       { passive: false });
    return () => {
      el.removeEventListener("touchstart",  onTouchStart);
      el.removeEventListener("touchmove",   onTouchMove);
      el.removeEventListener("touchend",    onTouchEnd);
      el.removeEventListener("touchcancel", onTouchCancel);
      el.removeEventListener("wheel",       onWheel);
    };
  }, [goNext, goPrev, slides]);

  const isDraggingState = dragPx !== 0;

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
        const transition = isDraggingState ? "none" : "transform 0.35s cubic-bezier(0.25,1,0.5,1)";

        if (slide.kind === "ad") {
          return (
            <div
              key={`ad-${slide.adIndex}`}
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
