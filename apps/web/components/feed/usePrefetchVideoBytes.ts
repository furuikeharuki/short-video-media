"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { MovieCard } from "@/lib/api/feed";
import { resolveMp4Url } from "@/lib/api/resolve-mp4";

/**
 * 現在再生中のスライドより先 N 枚分の動画バイトを裏で preload しておく hook。
 *
 * 背景:
 *   - WINDOW_SIZE=1 (中央 + 隣接 2 枚) で isAdjacent の <video> が currentIndex±1 の
 *     バイトを直接 preload するため、この hook は currentIndex+2 (= 「次の次」) だけを
 *     対象にする。
 *
 * 仕組み:
 *   - 隠した <video preload="auto" muted playsinline> を画面外に 1 個マウントする。
 *   - ブラウザの動画パイプラインが Range で先頭バッファを取得し、メモリに保持する。
 *
 * 仕様:
 *   - currentIndex + PREFETCH_AHEAD のスライド 1 枚を対象。
 *   - URL は毎回 resolveMp4Url で取得する (DB キャッシュ廃止後)。
 *     クライアントメモリの in-flight デデュープでバーストは抑制される。
 *   - currentIndex 変化時にウィンドウを更新 (古い preload はアンマウント)。
 *
 * 失敗ハンドリング (self-heal):
 *   - 隠し <video> が onError を発火した slug は failed set に記録し、
 *     resolveMp4Url(slug, { force: true }) で新 URL を取得して slot を差し替える。
 *   - 各 slug への self-heal は 1 回までに制限 (無限ループ防止)。
 */

// currentIndex + PREFETCH_AHEAD のスライドを1枚だけ preload する。
// PREFETCH_AHEAD=2 = 「次の次」 (隣接スライドは中央±1 なので +2 が次に中央になるスライド)。
const PREFETCH_AHEAD = 2;

// スクロール停止デバウンス。スクロール中は中央の <video> の帯域を奪わないよう
// 一定時間 currentIndex が止まってから slot 化 + resolve を発火する。
// usePrefetchResolveMp4 と同じ 400ms。
const PREFETCH_DEBOUNCE_MS = 400;

interface PrefetchSlot {
  /** key 用。MovieCard.id をそのまま使う */
  id: string;
  /** force re-resolve に使う */
  slug: string;
  /** <video src> に渡す URL */
  src: string;
}

export function usePrefetchVideoBytes(
  items: MovieCard[],
  currentIndex: number,
  isRapidSwiping: boolean = false,
): {
  slots: PrefetchSlot[];
  handleSlotError: (slug: string) => void;
} {
  const [slots, setSlots] = useState<PrefetchSlot[]>([]);
  // 進行中の resolveMp4Url を slug -> AbortController で管理。
  const inFlightRef = useRef<Map<string, AbortController>>(new Map());
  // 既に self-heal を 1 回試した slug。同 slug への無限リトライを防ぐ。
  const healedRef = useRef<Set<string>>(new Set());
  // slug -> MovieCard.id の逆引き。onError から slot を特定するため。
  const slugToIdRef = useRef<Map<string, string>>(new Map());

  // 対象スライド (currentIndex + PREFETCH_AHEAD の 1 枚) を安定キーで識別する。
  const targetIdx = currentIndex + PREFETCH_AHEAD;
  const targetItem = targetIdx < items.length ? items[targetIdx] : null;
  const targetId = targetItem?.id ?? "";
  const targetSlug = targetItem?.slug ?? "";

  useEffect(() => {
    const inFlight = inFlightRef.current;
    const slugToId = slugToIdRef.current;

    const hasTarget = !!(targetId && targetSlug);

    // slug -> id 逆引きを更新
    slugToId.clear();
    if (hasTarget) {
      slugToId.set(targetSlug, targetId);
    }

    // スクロール中は slots を一旦空にして隠し <video> をアンマウントし、
    // 中央の <video> への帯域集中を保つ。
    setSlots((prev) => (prev.length === 0 ? prev : []));

    // 進行中の resolve はすべて一旦 abort。
    for (const [slug, controller] of inFlight.entries()) {
      controller.abort();
      inFlight.delete(slug);
    }

    if (isRapidSwiping) {
      return;
    }

    // currentIndex が PREFETCH_DEBOUNCE_MS の間変わらなかったら resolve + slot 化。
    const timer = setTimeout(() => {
      if (!hasTarget) return;
      if (inFlight.has(targetSlug)) return;
      const controller = new AbortController();
      inFlight.set(targetSlug, controller);
      void resolveMp4Url(targetSlug, { signal: controller.signal })
        .then((res) => {
          if (controller.signal.aborted) return;
          if (!res?.mp4_url) return;
          setSlots((prev) => {
            if (prev.some((s) => s.id === targetId)) return prev;
            return [
              ...prev,
              { id: targetId, slug: targetSlug, src: res.mp4_url },
            ];
          });
        })
        .finally(() => {
          if (inFlight.get(targetSlug) === controller) {
            inFlight.delete(targetSlug);
          }
        });
    }, PREFETCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [targetId, targetSlug, isRapidSwiping]);

  // アンマウント時に全 resolve を abort
  useEffect(() => {
    const inFlight = inFlightRef.current;
    return () => {
      for (const controller of inFlight.values()) {
        controller.abort();
      }
      inFlight.clear();
    };
  }, []);

  // 隠し <video> から失敗通知を受けた時のハンドラ。
  // force=true で resolver を呼んで新 URL を取得し、slot を差し替えて再 preload。
  const handleSlotError = useCallback((slug: string) => {
    if (!slug) return;
    if (healedRef.current.has(slug)) return; // 既に 1 回試した slug は諦める
    healedRef.current.add(slug);

    const existing = inFlightRef.current.get(slug);
    if (existing) {
      existing.abort();
    }
    const controller = new AbortController();
    inFlightRef.current.set(slug, controller);

    void resolveMp4Url(slug, { force: true, signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        if (!res?.mp4_url) return;
        const id = slugToIdRef.current.get(slug);
        if (!id) return; // 既に対象範囲外
        setSlots((prev) => {
          const idx = prev.findIndex((s) => s.id === id);
          if (idx === -1) {
            return [...prev, { id, slug, src: res.mp4_url }];
          }
          const next = prev.slice();
          next[idx] = { id, slug, src: res.mp4_url };
          return next;
        });
      })
      .finally(() => {
        if (inFlightRef.current.get(slug) === controller) {
          inFlightRef.current.delete(slug);
        }
      });
  }, []);

  return { slots, handleSlotError };
}
