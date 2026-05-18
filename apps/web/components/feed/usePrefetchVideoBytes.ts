"use client";

import { useEffect, useRef, useState } from "react";

import type { MovieCard } from "@/lib/api/feed";
import { resolveMp4Url } from "@/lib/api/resolve-mp4";

/**
 * 現在再生中のスライドより先 N 枚分の動画バイトを裏で preload しておく hook。
 *
 * 目的:
 *   - usePrefetchResolveMp4 は「MP4 URL を取得する API レスポンス」のキャッシュを
 *     温めるだけで、動画ファイル自体は取りに行かない。
 *   - スワイプ到達時の体感を更に速くするため、CDN から動画の先頭部分も先取りする。
 *
 * 仕組み:
 *   - 隠した <video preload="auto" muted playsinline> を画面外に N 個マウントする。
 *   - ブラウザの動画パイプラインが Range で先頭バッファを取得し、メモリに保持する。
 *   - HTTP/2 多重化により、本物の <video> が再生開始するときも CDN との接続が
 *     温まっているため再生開始までの時間が短い。
 *
 * 仕様:
 *   - currentIndex+1 〜 currentIndex+PREFETCH_AHEAD のスライドを対象。
 *   - sample_movie_url を持つスライドはそのまま、持たないスライドは resolveMp4Url で
 *     URL を取得してから preload。
 *   - currentIndex 変化時にウィンドウを更新 (古い preload はアンマウント)。
 *   - 業界事例 (TikTok / Reels) では next 1-2 件が標準なので PREFETCH_AHEAD=2。
 *     これより多いと「見られない動画の通信」が増えて ROI が下がる。
 */

const PREFETCH_AHEAD = 2;

interface PrefetchSlot {
  /** key 用。MovieCard.id をそのまま使う */
  id: string;
  /** <video src> に渡す URL */
  src: string;
}

export function usePrefetchVideoBytes(
  items: MovieCard[],
  currentIndex: number,
): PrefetchSlot[] {
  const [slots, setSlots] = useState<PrefetchSlot[]>([]);
  // 進行中の resolveMp4Url を slug -> AbortController で管理。
  const inFlightRef = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    const inFlight = inFlightRef.current;
    // 対象スライドを集める
    const targets: MovieCard[] = [];
    for (let offset = 1; offset <= PREFETCH_AHEAD; offset += 1) {
      const idx = currentIndex + offset;
      if (idx >= items.length) break;
      const item = items[idx];
      if (item && item.slug) targets.push(item);
    }

    // sample_movie_url 持ちは即時に slot 化、持たないものは後で resolve
    const immediateSlots: PrefetchSlot[] = [];
    const toResolve: MovieCard[] = [];
    for (const item of targets) {
      if (item.sample_movie_url) {
        immediateSlots.push({ id: item.id, src: item.sample_movie_url });
      } else {
        toResolve.push(item);
      }
    }

    // 一旦 sample_movie_url 持ちだけで slots を更新 (即時に <video> マウント開始)
    setSlots(immediateSlots);

    // 対象から外れた進行中 resolve を abort
    const targetSlugs = new Set(toResolve.map((it) => it.slug));
    for (const [slug, controller] of inFlight.entries()) {
      if (!targetSlugs.has(slug)) {
        controller.abort();
        inFlight.delete(slug);
      }
    }

    // sample_movie_url を持たないスライドは resolve してから slot に追加
    for (const item of toResolve) {
      if (inFlight.has(item.slug)) continue;
      const controller = new AbortController();
      inFlight.set(item.slug, controller);
      void resolveMp4Url(item.slug, { signal: controller.signal })
        .then((res) => {
          if (controller.signal.aborted) return;
          if (!res?.mp4_url) return;
          setSlots((prev) => {
            // 既に同じ id が入っていたら重複しない
            if (prev.some((s) => s.id === item.id)) return prev;
            // 対象から外れていたら無視 (currentIndex が変わってる可能性)
            // この時点で再度ターゲット範囲を計算するのは過剰なので、
            // 古い slot が混ざっても次回 effect で正される。
            return [...prev, { id: item.id, src: res.mp4_url }];
          });
        })
        .finally(() => {
          if (inFlight.get(item.slug) === controller) {
            inFlight.delete(item.slug);
          }
        });
    }
  }, [items, currentIndex]);

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

  return slots;
}
