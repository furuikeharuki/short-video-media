"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FeedItem from "@/components/FeedItem";
import type { MovieCard } from "@/lib/api/feed";
import { markFeedGesture } from "@/components/feed/useFeedPlayback";
import { usePrefetchResolveMp4 } from "@/components/feed/usePrefetchResolveMp4";
import { usePrefetchVideoBytes } from "@/components/feed/usePrefetchVideoBytes";
import PrefetchVideoBuffer from "@/components/feed/PrefetchVideoBuffer";

// 同時にレンダリングするスライド数 = 中央 + 前後1枚ずつの計3枚。
// 4枚以上の `<video>` を同時に持つとモバイル Safari の同時接続上限に
// ぶつかってネットワーク待ちが連鎖し、再生が始まらなくなる。
const WINDOW_SIZE = 1;

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
  const currentIdxRef = useRef(initialIndex);
  const wheelLockRef  = useRef(false);
  const modalOpenRef  = useRef(false);

  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [windowItems,  setWindowItems]  = useState<MovieCard[]>([]);
  const windowStartRef = useRef(0);

  // 先 3 枚分の MP4 URL を resolver で事前解決しておき、スワイプ到達時の
  // 再生開始を早める (resolver 側の 60s キャッシュを温めるだけで <video> は増やさない)。
  usePrefetchResolveMp4(items, currentIndex);

  // 更に先 2 枚分の動画バイトも先読み (隠し <video preload="auto"> を画面外にマウント)。
  // DMM CDN は Cache-Control: no-store だが CloudFront 側にキャッシュがあるため、
  // <video> のメディアバイトを事前に採ると HTTP/2 接続が温まり、再生開始が早くなる。
  // prefetch 中の <video> が失敗したら handleSlotError で self-heal (DB キャッシュ無効化 + force resolve)。
  const { slots: prefetchSlots, handleSlotError } = usePrefetchVideoBytes(
    items,
    currentIndex,
  );

  const [dragPx,         setDragPx]       = useState(0);
  const dragStartY       = useRef(0);
  const dragStartYForEnd = useRef(0);
  const dragStartTime    = useRef(0);
  const isDragging       = useRef(false);

  // モーダル開閉状態をカスタムイベントで受け取る
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

  const updateWindow = useCallback((idx: number) => {
    const start = Math.max(0, idx - WINDOW_SIZE);
    const end   = Math.min(items.length, idx + WINDOW_SIZE + 1);
    windowStartRef.current = start;
    setWindowItems(items.slice(start, end));
  }, [items]);

  // 初期インデックスを適用するのはマウント時 1 回だけ。
  // fetchMore() で items が追記されるたびにこの effect が再生して
  // setCurrentIndex(initialIndex) で先頭に戻されてしまうバグを防ぐ。
  // items が増えるだけのケースは windowItems を現在 idx で再計算すればよい。
  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) {
      // 2 回目以降: items が追記されたときは window だけ現在 idx で更新。
      // 現在インデックスが新しい items 長の範囲を越えないようクランプ。
      const clamped = Math.min(currentIdxRef.current, Math.max(0, items.length - 1));
      if (clamped !== currentIdxRef.current) {
        currentIdxRef.current = clamped;
        setCurrentIndex(clamped);
      }
      updateWindow(clamped);
      return;
    }
    didInitRef.current = true;
    currentIdxRef.current = initialIndex;
    setCurrentIndex(initialIndex);
    updateWindow(initialIndex);
  }, [items, initialIndex, updateWindow]);

  const goNext = useCallback(() => {
    const nextIdx = currentIdxRef.current + 1;
    if (nextIdx >= items.length) return;
    // スワイプやホイールによるスライド遷移をユーザー操作としてマークし、次動画の unmuted 自動再生を許す
    markFeedGesture();
    currentIdxRef.current = nextIdx;
    setCurrentIndex(nextIdx);
    updateWindow(nextIdx);
    onIndexChange?.(nextIdx);
    if (items.length - nextIdx <= 5) onNearEnd?.(nextIdx);
  }, [items, updateWindow, onNearEnd, onIndexChange]);

  const goPrev = useCallback(() => {
    const next = Math.max(0, currentIdxRef.current - 1);
    if (next === currentIdxRef.current) return;
    markFeedGesture();
    currentIdxRef.current = next;
    setCurrentIndex(next);
    updateWindow(next);
    onIndexChange?.(next);
  }, [updateWindow, onIndexChange]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      if (modalOpenRef.current) return;
      const y = e.touches[0].clientY;
      isDragging.current       = true;
      dragStartY.current       = y;
      dragStartYForEnd.current = y;
      dragStartTime.current    = Date.now();
      setDragPx(0);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (modalOpenRef.current) return;
      e.preventDefault();
      if (!isDragging.current) return;
      const dy    = e.touches[0].clientY - dragStartY.current;
      const atEnd = currentIdxRef.current >= items.length - 1;
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

    const onTouchCancel = () => {
      isDragging.current = false;
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
  }, [goNext, goPrev, items]);

  const isDraggingState = dragPx !== 0;

  return (
    <div ref={containerRef} className="feed-container">
      {prefetchSlots.map((slot) => (
        <PrefetchVideoBuffer
          key={slot.id}
          slug={slot.slug}
          src={slot.src}
          onError={handleSlotError}
        />
      ))}
      {windowItems.map((item, i) => {
        const absIndex = windowStartRef.current + i;
        const offset   = absIndex - currentIndex;
        const isActive = offset === 0;
        const transform  = `translateY(calc(${offset * 100}% + ${dragPx}px))`;
        const transition = isDraggingState ? "none" : "transform 0.35s cubic-bezier(0.25,1,0.5,1)";
        return (
          <div
            // key を absIndex に依存させない。スワイプの度に再マウントされて
            // <video> が読み込み直しになるのを防ぐ。
            key={item.id}
            className="feed-slide"
            style={{
              transform,
              transition,
              zIndex:        isActive ? 2 : 1,
              pointerEvents: isActive ? "auto" : "none",
            }}
          >
            <FeedItem
              item={item}
              isActive={isActive}
              isFirst={absIndex === 0}
              isSecond={absIndex === 1}
            />
          </div>
        );
      })}
    </div>
  );
}
