"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { MovieCard } from "@/lib/api/feed";
import { invalidateSampleUrl, resolveMp4Url } from "@/lib/api/resolve-mp4";

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
 *   - これでモバイル Safari の同時接続上限 (約 4) は
 *     中央 1 + 隣接 2 + この先読み 1 = 計 4 で上限ギリギリ。
 *
 * 仕様:
 *   - currentIndex + PREFETCH_AHEAD のスライド 1 枚を対象。
 *   - URL 取得は resolveMp4Url のクライアントメモリキャッシュを使うため、
 *     usePrefetchResolveMp4 が温めたキャッシュがあれば新規 API は叩かない。
 *     (キャッシュがないケースは resolveMp4Url が API を叩いてキャッシュを温める。)
 *   - currentIndex 変化時にウィンドウを更新 (古い preload はアンマウント)。
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

// currentIndex + PREFETCH_AHEAD のスライドを1枚だけ preload する。
// PREFETCH_AHEAD=2 = 「次の次」 (隣接スライドは中央±1 なので +2 が次に中央になるスライド)。
const PREFETCH_AHEAD = 2;

// スクロール停止デバウンス。cachedSrc 有無に関わらず適用する。
// - cachedSrc 有 (sample_movie_url 持ち): 隠し <video> で事前バイト取得を始めるが、
//   スクロール中は中央の <video> の帯域を奪わないようにデバウンスしてから slot 化する。
// - cachedSrc 無 (resolve 必要): resolver VPS にキューイングしないよう同じくデバウンス。
// usePrefetchResolveMp4 と同じ 400ms。
const PREFETCH_DEBOUNCE_MS = 400;

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
  // 親が毎レンダー新しい items 配列を渡してきても、対象 slide が変わっていなければ
  // effect を再実行しない。これにより setSlots([]) の連鎖再レンダーを防ぐ。
  const targetIdx = currentIndex + PREFETCH_AHEAD;
  const targetItem = targetIdx < items.length ? items[targetIdx] : null;
  const targetId = targetItem?.id ?? "";
  const targetSlug = targetItem?.slug ?? "";
  const targetSampleUrl = targetItem?.sample_movie_url ?? "";

  useEffect(() => {
    const inFlight = inFlightRef.current;
    const slugToId = slugToIdRef.current;

    // 対象スライド (currentIndex + PREFETCH_AHEAD の 1 枚だけ) の最小情報。
    // currentIndex±1 は WINDOW_SIZE=1 の隣接スライド (isAdjacent) がすでに直接 preload している。
    const hasTarget = !!(targetId && targetSlug);

    // slug -> id 逆引きを更新
    slugToId.clear();
    if (hasTarget) {
      slugToId.set(targetSlug, targetId);
    }

    // スクロール中は cachedSrc 有無に関わらず slots を一旦空にする。
    // これにより隠し <video> がアンマウントされ、中央の <video> への帯域集中を保てる。
    // スクロールが PREFETCH_DEBOUNCE_MS の間止まってから slot 化を再開する。
    // 既に空のときは新しい [] を渡さず prev をそのまま返すことで、setState の
    // 同値 bail-out を発火させて不要な再レンダー (= 親の再レンダー → items 配列
    // 新参照 → 当 effect 再実行 → setSlots([]) ループ) を防ぐ。
    setSlots((prev) => (prev.length === 0 ? prev : []));

    // 進行中の resolve はすべて一旦 abort。スクロール停止したときに改めて起動する。
    for (const [slug, controller] of inFlight.entries()) {
      controller.abort();
      inFlight.delete(slug);
    }

    // 高速スワイプ中は隠し <video> のマウントも resolve も走らせない。
    // 中央の <video> が同時接続枠 / 帯域を独占できるようにする。
    // スワイプが止まれば isRapidSwiping=false でこの effect が再実行されて
    // 通常の debounce 経路で slot が立ち上がる。
    if (isRapidSwiping) {
      return;
    }

    // currentIndex が PREFETCH_DEBOUNCE_MS の間変わらなかったら slot 化 + resolve 発火。
    // - cachedSrc 有: すぐ slot 化され、隠し <video> がマウントしてバイト先読み開始
    // - cachedSrc 無: resolveMp4Url を呼んで取得し、成功したら slot に追加
    const timer = setTimeout(() => {
      if (!hasTarget) return;
      if (targetSampleUrl) {
        const nextSlot: PrefetchSlot = {
          id: targetId,
          slug: targetSlug,
          src: targetSampleUrl,
        };
        // 既に同 id / src で slot 化済みなら再度 setState しない (再レンダー回避)。
        setSlots((prev) => {
          if (
            prev.length === 1 &&
            prev[0].id === nextSlot.id &&
            prev[0].src === nextSlot.src
          ) {
            return prev;
          }
          return [nextSlot];
        });
      } else {
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
      }
    }, PREFETCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
    // items 配列そのものではなく、対象スライドの id / slug / sample_movie_url を
    // deps にする。親の毎レンダー (新しい items 配列参照) で effect が走らないよう
    // にするため。currentIndex / isRapidSwiping は従来通り。
  }, [targetId, targetSlug, targetSampleUrl, isRapidSwiping]);

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
