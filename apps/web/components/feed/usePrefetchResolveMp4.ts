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
 *   - 同 slug に対する重複スケジューリングを抑制: 本 hook 単位で「resolve 成功
 *     済みの slug」を覚えておき、currentIndex が小刻みに変化する近傍 (例: 隣に
 *     スワイプ → 戻る) で何度も同じ slug を resolve しに行かないようにする。
 *     失敗 (null) は永続抑制せず、`FAILURE_TTL_MS` 経過後にリトライ可能に戻す。
 */

const PREFETCH_AHEAD = 5;
const PREFETCH_DEBOUNCE_MS = 400;
/** 失敗 (null) を覚えておく時間。これを過ぎたら再度 prefetch を試みる。 */
const FAILURE_TTL_MS = 30_000;

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
  /** resolve 成功して mp4_url を取れた slug。重複スケジューリング抑制用。 */
  const resolvedSlugsRef = useRef<Set<string>>(new Set());
  /** 直近 resolve が失敗 (null) した slug → 失敗時刻 (ms)。TTL 経過で再試行可能に戻る。 */
  const failedSlugsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const inFlight = inFlightRef.current;
    const resolved = resolvedSlugsRef.current;
    const failed = failedSlugsRef.current;

    /** 既に resolve 済み or 失敗 TTL 内なら true。 */
    const isAlreadyHandled = (slug: string): boolean => {
      if (resolved.has(slug)) return true;
      const failedAt = failed.get(slug);
      if (failedAt !== undefined) {
        if (Date.now() - failedAt < FAILURE_TTL_MS) return true;
        // TTL 経過 → 再試行可能に戻す
        failed.delete(slug);
      }
      return false;
    };

    // 対象: priority=0 (active) と priority=1..PREFETCH_AHEAD。
    // priority=0 は高速スワイプ中でも即発火、priority>=1 はデバウンス待ちで発火。
    // 同一スライド遷移内 (同じ useEffect 実行内) の重複 priority も Set で除去。
    type Target = { slug: string; priority: number };
    const seenSlugs = new Set<string>();
    const targets: Target[] = [];
    for (let offset = 0; offset <= PREFETCH_AHEAD; offset += 1) {
      const idx = currentIndex + offset;
      if (idx < 0 || idx >= items.length) continue;
      const item = items[idx];
      if (!item || !item.slug) continue;
      if (seenSlugs.has(item.slug)) continue;
      seenSlugs.add(item.slug);
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

    /**
     * 1 つの target に対して fetch を発火する。
     * 既に in-flight / resolve 済み / 失敗 TTL 内ならスキップ。
     */
    const schedule = (target: Target, scheduledIndex: number) => {
      if (inFlight.has(target.slug)) return;
      if (isAlreadyHandled(target.slug)) {
        vtPrefetchLog(
          `skip cached index=${scheduledIndex} priority=${target.priority} slug=${target.slug}`,
        );
        return;
      }
      const controller = new AbortController();
      inFlight.set(target.slug, controller);
      vtPrefetchLog(
        `resolve start index=${scheduledIndex} priority=${target.priority} slug=${target.slug}`,
      );
      void resolveMp4Url(target.slug, { signal: controller.signal })
        .then((res) => {
          if (controller.signal.aborted) return;
          const got = !!res?.mp4_url;
          if (got) {
            resolved.add(target.slug);
            failed.delete(target.slug);
          } else {
            // 失敗は TTL 付きで覚える (永続抑制しない)。
            failed.set(target.slug, Date.now());
          }
          vtPrefetchLog(
            `resolve ok index=${scheduledIndex} priority=${target.priority} slug=${target.slug} got=${got}`,
          );
        })
        .finally(() => {
          if (inFlight.get(target.slug) === controller) {
            inFlight.delete(target.slug);
          }
        });
    };

    // active (priority=0) は常に即発火。高速スワイプ中でも遅らせない。
    const active = targets.find((t) => t.priority === 0);
    if (active) {
      schedule(active, currentIndex);
    }

    // priority>=1 は高速スワイプ中は発火しない。落ち着いてから debounce 経過後に発火。
    if (isRapidSwiping) {
      return;
    }

    const upcoming = targets.filter((t) => t.priority >= 1);
    const timer = setTimeout(() => {
      for (const target of upcoming) {
        schedule(target, currentIndex + target.priority);
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
