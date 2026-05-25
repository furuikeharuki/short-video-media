"use client";

import { useEffect, useRef } from "react";

import type { MovieCard } from "@/lib/api/feed";
import { resolveMp4Url } from "@/lib/api/resolve-mp4";
import { isVideoTimingEnabled } from "@/lib/videoTiming";

/**
 * 現在のスライド (active) + 直後 N 枚分の MP4 URL を resolver に事前解決させておく hook。
 *
 * 単一 <video> 戦略への移行に伴い、低画質ファースト戦略は撤去された。
 * 代わりに resolve 先読みを priority-based に強化し、ユーザーの再生体感を改善する:
 *
 *   - active (priority=0) は高速スワイプ中でも即座に発火。ユーザーが今見ている
 *     スライドの resolve が一番大事。`useResolvedVideoSrc` 側でも resolve は走るが、
 *     そちらは <video> マウント後に動くため、active を本 hook で先取りすると
 *     並列で resolve が始まり早く着地できる。
 *   - active + 1..PREFETCH_AHEAD (priority>=1) は高速スワイプが落ち着いてから
 *     `PREFETCH_DEBOUNCE_MS` 後に順次発火。
 *
 * 仕様:
 *   - in-flight デデュープと並列度上限は `resolveMp4Url` 側で管理 (resolveCache /
 *     MAX_CONCURRENT_FETCHES)。本 hook ではそれを尊重するだけ。
 *   - currentIndex が変わったら、対象外になった prefetch は abort して帯域を節約。
 *   - キャッシュ済み URL は `resolveMp4Url` が即返すので、本 hook の発火コストはほぼゼロ。
 *   - アンマウント時に全 prefetch を abort。
 */

const PREFETCH_AHEAD = 5;
const PREFETCH_DEBOUNCE_MS = 400;

function vtPrefetchLog(message: string) {
  if (!isVideoTimingEnabled()) return;
  // eslint-disable-next-line no-console
  console.debug(`vt prefetch ${message}`);
}

export function usePrefetchResolveMp4(
  items: MovieCard[],
  currentIndex: number,
  isRapidSwiping: boolean = false,
): void {
  const inFlightRef = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    const inFlight = inFlightRef.current;

    // 対象: priority=0 (active) と priority=1..PREFETCH_AHEAD。
    // priority=0 は高速スワイプ中でも即発火、priority>=1 はデバウンス待ちで発火。
    type Target = { slug: string; priority: number };
    const targets: Target[] = [];
    for (let offset = 0; offset <= PREFETCH_AHEAD; offset += 1) {
      const idx = currentIndex + offset;
      if (idx < 0 || idx >= items.length) continue;
      const item = items[idx];
      if (!item || !item.slug) continue;
      targets.push({ slug: item.slug, priority: offset });
    }
    const newTargetSlugs = new Set(targets.map((t) => t.slug));

    // 対象外になった進行中 prefetch を abort。
    for (const [slug, controller] of inFlight.entries()) {
      if (!newTargetSlugs.has(slug)) {
        controller.abort();
        inFlight.delete(slug);
      }
    }

    // active (priority=0) は常に即発火。高速スワイプ中でも遅らせない。
    const active = targets.find((t) => t.priority === 0);
    if (active && !inFlight.has(active.slug)) {
      const controller = new AbortController();
      inFlight.set(active.slug, controller);
      vtPrefetchLog(`resolve start index=${currentIndex} priority=0 slug=${active.slug}`);
      void resolveMp4Url(active.slug, { signal: controller.signal })
        .then((res) => {
          if (controller.signal.aborted) return;
          vtPrefetchLog(
            `resolve ok index=${currentIndex} priority=0 slug=${active.slug} got=${!!res?.mp4_url}`,
          );
        })
        .finally(() => {
          if (inFlight.get(active.slug) === controller) {
            inFlight.delete(active.slug);
          }
        });
    }

    // priority>=1 は高速スワイプ中は発火しない。落ち着いてから debounce 経過後に発火。
    if (isRapidSwiping) {
      return;
    }

    const upcoming = targets.filter((t) => t.priority >= 1);
    const timer = setTimeout(() => {
      for (const target of upcoming) {
        if (inFlight.has(target.slug)) continue;
        const controller = new AbortController();
        inFlight.set(target.slug, controller);
        vtPrefetchLog(
          `resolve start index=${currentIndex + target.priority} priority=${target.priority} slug=${target.slug}`,
        );
        void resolveMp4Url(target.slug, { signal: controller.signal })
          .then((res) => {
            if (controller.signal.aborted) return;
            vtPrefetchLog(
              `resolve ok index=${currentIndex + target.priority} priority=${target.priority} slug=${target.slug} got=${!!res?.mp4_url}`,
            );
          })
          .finally(() => {
            if (inFlight.get(target.slug) === controller) {
              inFlight.delete(target.slug);
            }
          });
      }
    }, PREFETCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [items, currentIndex, isRapidSwiping]);

  useEffect(() => {
    const inFlight = inFlightRef.current;
    return () => {
      for (const controller of inFlight.values()) {
        controller.abort();
      }
      inFlight.clear();
    };
  }, []);
}
