"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { MovieCard } from "@/lib/api/feed";
import { invalidateSampleUrl, resolveMp4Url } from "@/lib/api/resolve-mp4";

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
 *
 * 失敗ハンドリング (self-heal):
 *   - 隠し <video> が onError を発火した slug は failed set に記録し、
 *     1. invalidateSampleUrl(slug) で DB の sample_movie_url を NULL に戻す
 *     2. resolveMp4Url(slug, { force: true }) で resolver を呼び直して新 URL を取得
 *     3. 新 URL を slot に差し替えて再 preload
 *     を fire-and-forget で実行する。これにより、ユーザーがスワイプ到達する前に
 *     失敗を検知して回復できる。
 *   - 各 slug への self-heal は 1 回までに制限 (無限ループ防止)。
 */

const PREFETCH_AHEAD = 2;

interface PrefetchSlot {
  /** key 用。MovieCard.id をそのまま使う */
  id: string;
  /** invalidate / re-resolve に使う */
  slug: string;
  /** <video src> に渡す URL */
  src: string;
}

export function usePrefetchVideoBytes(
  items: MovieCard[],
  currentIndex: number,
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

  useEffect(() => {
    const inFlight = inFlightRef.current;
    const slugToId = slugToIdRef.current;

    // 対象スライドを集める
    const targets: MovieCard[] = [];
    for (let offset = 1; offset <= PREFETCH_AHEAD; offset += 1) {
      const idx = currentIndex + offset;
      if (idx >= items.length) break;
      const item = items[idx];
      if (item && item.slug) targets.push(item);
    }

    // slug -> id 逆引きを更新
    slugToId.clear();
    for (const item of targets) {
      slugToId.set(item.slug, item.id);
    }

    // sample_movie_url 持ちは即時に slot 化、持たないものは後で resolve
    const immediateSlots: PrefetchSlot[] = [];
    const toResolve: MovieCard[] = [];
    for (const item of targets) {
      if (item.sample_movie_url) {
        immediateSlots.push({
          id: item.id,
          slug: item.slug,
          src: item.sample_movie_url,
        });
      } else {
        toResolve.push(item);
      }
    }

    // 一旦 sample_movie_url 持ちだけで slots を更新
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
            if (prev.some((s) => s.id === item.id)) return prev;
            return [
              ...prev,
              { id: item.id, slug: item.slug, src: res.mp4_url },
            ];
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

  // 隠し <video> から失敗通知を受けた時のハンドラ。
  // 1. DB の sample_movie_url を NULL に戻す
  // 2. force=true で resolver を呼んで新 URL を取得
  // 3. 新 URL で slot を差し替えて再 preload を起動
  const handleSlotError = useCallback((slug: string) => {
    if (!slug) return;
    if (healedRef.current.has(slug)) return; // 既に 1 回試した slug は諦める
    healedRef.current.add(slug);

    // DB クリーンアップは fire-and-forget
    void invalidateSampleUrl(slug);

    // 既存の resolve が走っていれば abort して force resolve に切り替え
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
          // 該当 slot を新 URL に差し替え。React の key 衝突を避けるため
          // id は維持する (PrefetchVideoBuffer は src 変化を useEffect で検知して load())
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
