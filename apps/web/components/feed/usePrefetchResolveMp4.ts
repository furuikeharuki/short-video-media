"use client";

import { useEffect, useRef } from "react";

import type { MovieCard } from "@/lib/api/feed";
import { resolveMp4Url } from "@/lib/api/resolve-mp4";

/**
 * 現在再生中のスライドより先 N 枚分の MP4 URL を resolver に事前解決させておく hook。
 *
 * 目的:
 *   - ユーザーがスワイプして次のスライドに到達した瞬間に再生が始まるよう、
 *     resolver の 60 秒成功キャッシュを温めておく。
 *   - <video> 要素は増やさない (モバイル Safari の同時接続上限を避けるため
 *     WINDOW_SIZE=1 を維持)。あくまで API レスポンスのキャッシュだけ温める。
 *
 * 仕様:
 *   - currentIndex+1 〜 currentIndex+PREFETCH_AHEAD のスライドを対象。
 *   - sample_movie_url を既に持っているスライドはスキップ
 *     (optimistic に再生できるので resolver を温める必要がない)。
 *   - レスポンスは捨てる。in-flight デデュープ + 60 秒キャッシュは API 側に任せる。
 *   - currentIndex が変わったら飛んでいる prefetch を abort。
 *   - アンマウント時にも abort。
 */

const PREFETCH_AHEAD = 3;

export function usePrefetchResolveMp4(
  items: MovieCard[],
  currentIndex: number,
): void {
  // 同時に飛ばしている prefetch を slug -> AbortController で管理。
  const inFlightRef = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    const inFlight = inFlightRef.current;

    // 対象スライドの slug を集める。
    const targetSlugs = new Set<string>();
    for (let offset = 1; offset <= PREFETCH_AHEAD; offset += 1) {
      const idx = currentIndex + offset;
      if (idx >= items.length) break;
      const item = items[idx];
      if (!item) continue;
      if (item.sample_movie_url) continue; // optimistic ヒット予定なのでスキップ
      if (!item.slug) continue;
      targetSlugs.add(item.slug);
    }

    // 対象から外れた prefetch は abort。
    for (const [slug, controller] of inFlight.entries()) {
      if (!targetSlugs.has(slug)) {
        controller.abort();
        inFlight.delete(slug);
      }
    }

    // 新規対象を発火 (既に飛んでいる slug は二重に叩かない)。
    for (const slug of targetSlugs) {
      if (inFlight.has(slug)) continue;
      const controller = new AbortController();
      inFlight.set(slug, controller);
      // fire-and-forget。レスポンスは捨てる。
      // resolveMp4Url は内部で例外を握り潰すので追加 catch は不要。
      void resolveMp4Url(slug, { signal: controller.signal }).finally(() => {
        if (inFlight.get(slug) === controller) {
          inFlight.delete(slug);
        }
      });
    }
  }, [items, currentIndex]);

  // アンマウント時に全 prefetch を abort。
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
