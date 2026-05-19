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
// スクロール停止デバウンス: currentIndex がこの期間変わらなかったら「スクロール停止」とみなして prefetch を起動する。
// これを入れないと、20 枚一気スクロールしたときに 60 件以上の resolve リクエストが resolver VPS にキューイングして、
// 実際に見ているスライドの resolve がキューの後ろに回されて遅くなる。
const PREFETCH_DEBOUNCE_MS = 400;

export function usePrefetchResolveMp4(
  items: MovieCard[],
  currentIndex: number,
): void {
  // 同時に飛ばしている prefetch を slug -> AbortController で管理。
  const inFlightRef = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    const inFlight = inFlightRef.current;

    // currentIndex が変わった瞬間、まずは対象外になった進行中 prefetch を abort してロードを減らす。
    // (進行中のものはサーバー側の Playwright は止まらないが、クライアントのオープンソケットは閉じる)。
    // その上で PREFETCH_DEBOUNCE_MS 待ってから新規 prefetch を出す。
    const newTargetSlugs = new Set<string>();
    for (let offset = 1; offset <= PREFETCH_AHEAD; offset += 1) {
      const idx = currentIndex + offset;
      if (idx >= items.length) break;
      const item = items[idx];
      if (!item) continue;
      if (item.sample_movie_url) continue;
      if (!item.slug) continue;
      newTargetSlugs.add(item.slug);
    }
    for (const [slug, controller] of inFlight.entries()) {
      if (!newTargetSlugs.has(slug)) {
        controller.abort();
        inFlight.delete(slug);
      }
    }

    // デバウンス: 一定時間 currentIndex が変らなければ、その時点で対象の prefetch を発火する。
    // デバウンス中に currentIndex が進んだ場合 は setTimeout の cleanup でキャンセルされる。
    const timer = setTimeout(() => {
      for (const slug of newTargetSlugs) {
        if (inFlight.has(slug)) continue;
        const controller = new AbortController();
        inFlight.set(slug, controller);
        void resolveMp4Url(slug, { signal: controller.signal }).finally(() => {
          if (inFlight.get(slug) === controller) {
            inFlight.delete(slug);
          }
        });
      }
    }, PREFETCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
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
