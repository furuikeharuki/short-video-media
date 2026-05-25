"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { MovieCard } from "@/lib/api/feed";
import { resolveMp4Url } from "@/lib/api/resolve-mp4";
import { ensurePreconnect, getPrefetchPolicy } from "@/lib/networkPrefs";
import { isVideoTimingEnabled } from "@/lib/videoTiming";

/**
 * 現在再生中のスライドより先 N 枚分の動画バイトを裏で preload しておく hook。
 *
 * 背景:
 *   - 隣接 FeedItem (`isAdjacent`) も <video> をマウントするが、ユーザーが
 *     スワイプ確定するまで現スライドの再生・帯域を優先するため、必ずしも
 *     +1 のバイト取得が間に合うとは限らない。そのため本 hook では
 *     "次に中央になる" current+1 を最優先で裏 prefetch する権威ソースとして扱う。
 *   - ブラウザに応じて先読み枚数を変える:
 *       * Chrome / Chromium: current+1 と +2 の 2 枚を bytes 先読み
 *       * Safari / iOS Safari: current+1 のみ、preload="metadata" でメタデータだけ取得
 *       * Save-Data / 2g / slow-2g: 完全に止める
 *   - rapid swipe 中 / target スライドが存在しない場合は slot を 0 にして
 *     隠し <video> をアンマウントし、中央 <video> の帯域を奪わない。
 *
 * 仕組み:
 *   - 隠した <video> を画面外に N 個マウントする。
 *   - ブラウザの動画パイプラインが Range で先頭バッファを取得し、メモリに保持する。
 *
 * 失敗ハンドリング (self-heal):
 *   - 隠し <video> が onError を発火した slug は失敗扱いとし、
 *     resolveMp4Url(slug, { force: true }) で新 URL を取得して slot を差し替える。
 *   - 各 slug への self-heal は 1 回までに制限 (無限ループ防止)。
 */

/**
 * current+1 を最優先で先読みする (隣接 <video> の preload は active 再生に
 * 帯域を譲って遅れることがあるため、本 hook が次スライドのバイト取得を担う)。
 * 何枚先まで読むかは getPrefetchPolicy() に従い、ブラウザと回線で決める。
 */
const PREFETCH_START_OFFSET = 1;

// rapid swipe が落ち着いた直後に current+1 の resolve をすぐ走らせるための短デバウンス。
// 0 ms にすると React の同期再レンダで余計な resolve が走り得るため最小値だけ確保。
const NEXT_PREFETCH_DEBOUNCE_MS = 50;

// current+1 以降のスロット (+2 など) は中央 <video> の安定再生を優先したいので
// 従来通り少し待ってから resolve する。
const UPCOMING_PREFETCH_DEBOUNCE_MS = 400;

function vtPrefetchLog(message: string) {
  if (!isVideoTimingEnabled()) return;
  // eslint-disable-next-line no-console
  console.debug(`vt byte-prefetch ${message}`);
}

interface PrefetchSlot {
  /** key 用。MovieCard.id をそのまま使う */
  id: string;
  /** force re-resolve に使う */
  slug: string;
  /** <video src> に渡す URL */
  src: string;
  /** 隠し <video> の preload 属性 (Safari は "metadata", Chrome は "auto") */
  preload: "auto" | "metadata" | "none";
  /** dev ログ用: currentIndex からのオフセット (+1, +2 など)。 */
  offset: number;
}

interface Target {
  id: string;
  slug: string;
  offset: number;
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
  // dev ログ用: byte-prefetch slot が出来たことのある slug を覚えておき、
  // active 移動時にそのスライドが裏 prefetch 済みだったか出力する。
  const prefetchedSlugsRef = useRef<Set<string>>(new Set());
  const lastActiveSlugRef = useRef<string | null>(null);

  // ポリシー (aheadCount / preload) を計算する。effect 内で毎回読むと
  // navigator アクセスが増えるので useEffect の中で 1 度だけ参照する。
  // 回線状況は途中で変わり得るが、本サイトは短時間セッションなので静的取得で十分。

  // 対象スライドの一覧 (id+slug+offset) を currentIndex / items から決める。
  // policy.aheadCount = 1 → +1 だけ / 2 → +1 と +2。
  // ここで targets を実 effect が走る前に算出しておくと、deps として安定 key (id 連結) を使える。
  const policy = getPrefetchPolicyMemo();
  const targets: Target[] = [];
  if (policy.aheadCount > 0) {
    for (let i = 0; i < policy.aheadCount; i += 1) {
      const offset = PREFETCH_START_OFFSET + i;
      const idx = currentIndex + offset;
      if (idx >= items.length) break;
      const it = items[idx];
      if (!it || !it.slug) continue;
      targets.push({ id: it.id, slug: it.slug, offset });
    }
  }
  // deps 用に安定キーを生成 (id の join)。
  const targetsKey = targets.map((t) => `${t.id}:${t.slug}:${t.offset}`).join("|");

  // active スライドが変わったタイミングで、そのスライドが裏 prefetch 済みだったかを
  // dev ログに出す (loadedmetadata +9s 等を取り逃したかの確認用)。
  useEffect(() => {
    if (!isVideoTimingEnabled()) return;
    const activeItem = items[currentIndex];
    if (!activeItem || !activeItem.slug) return;
    if (lastActiveSlugRef.current === activeItem.slug) return;
    lastActiveSlugRef.current = activeItem.slug;
    const prefetched = prefetchedSlugsRef.current.has(activeItem.slug);
    vtPrefetchLog(
      `active index=${currentIndex} slug=${activeItem.slug} byte-prefetched=${prefetched}`,
    );
  }, [currentIndex, items]);

  useEffect(() => {
    const inFlight = inFlightRef.current;
    const slugToId = slugToIdRef.current;

    // slug -> id 逆引きを更新
    slugToId.clear();
    for (const t of targets) {
      slugToId.set(t.slug, t.id);
    }

    // スクロール中 / Save-Data 等で targets が空のとき: slots と進行中 resolve をクリアして
    // 隠し <video> をアンマウントし、中央の <video> への帯域集中を保つ。
    setSlots((prev) => {
      if (targets.length === 0) {
        return prev.length === 0 ? prev : [];
      }
      // 既存 slot のうち target に残っているものは保持。それ以外はアンマウント。
      const wanted = new Set(targets.map((t) => t.id));
      const filtered = prev.filter((s) => wanted.has(s.id));
      return filtered.length === prev.length ? prev : filtered;
    });

    // target から外れた slug の進行中 resolve は abort。
    const targetSlugs = new Set(targets.map((t) => t.slug));
    for (const [slug, controller] of inFlight.entries()) {
      if (!targetSlugs.has(slug)) {
        controller.abort();
        inFlight.delete(slug);
      }
    }

    if (isRapidSwiping || targets.length === 0) {
      return;
    }

    // current+1 はほぼ即時に発火し、+2 以降は中央 <video> 安定再生のため少し遅らせる。
    const nextTarget = targets.find((t) => t.offset === PREFETCH_START_OFFSET);
    const upcomingTargets = targets.filter((t) => t.offset > PREFETCH_START_OFFSET);

    const fire = (target: Target) => {
      if (inFlight.has(target.slug)) return;
      const controller = new AbortController();
      inFlight.set(target.slug, controller);
      vtPrefetchLog(
        `slot index=${currentIndex + target.offset} slug=${target.slug} offset=+${target.offset} mode=${policy.preload}`,
      );
      void resolveMp4Url(target.slug, { signal: controller.signal })
        .then((res) => {
          if (controller.signal.aborted) return;
          if (!res?.mp4_url) return;
          // 解決した CDN origin に dyn preconnect (TCP/TLS handshake を前倒し)。
          ensurePreconnect(res.mp4_url);
          prefetchedSlugsRef.current.add(target.slug);
          setSlots((prev) => {
            if (prev.some((s) => s.id === target.id)) return prev;
            return [
              ...prev,
              {
                id: target.id,
                slug: target.slug,
                src: res.mp4_url,
                preload: policy.preload,
                offset: target.offset,
              },
            ];
          });
        })
        .finally(() => {
          if (inFlight.get(target.slug) === controller) {
            inFlight.delete(target.slug);
          }
        });
    };

    const nextTimer = nextTarget
      ? setTimeout(() => fire(nextTarget), NEXT_PREFETCH_DEBOUNCE_MS)
      : null;
    const upcomingTimer =
      upcomingTargets.length > 0
        ? setTimeout(() => {
            for (const target of upcomingTargets) fire(target);
          }, UPCOMING_PREFETCH_DEBOUNCE_MS)
        : null;

    return () => {
      if (nextTimer) clearTimeout(nextTimer);
      if (upcomingTimer) clearTimeout(upcomingTimer);
    };
    // targetsKey / isRapidSwiping / policy.preload・aheadCount が変わったときに走り直す。
    // targets は毎レンダー新オブジェクトなので key 化した文字列を使う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetsKey, isRapidSwiping, policy.preload, policy.aheadCount, currentIndex]);

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
  const handleSlotError = useCallback(
    (slug: string) => {
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
          ensurePreconnect(res.mp4_url);
          const id = slugToIdRef.current.get(slug);
          if (!id) return; // 既に対象範囲外
          setSlots((prev) => {
            const idx = prev.findIndex((s) => s.id === id);
            const existingOffset = idx >= 0 ? prev[idx].offset : PREFETCH_START_OFFSET;
            const next: PrefetchSlot = {
              id,
              slug,
              src: res.mp4_url,
              preload: policy.preload,
              offset: existingOffset,
            };
            if (idx === -1) {
              return [...prev, next];
            }
            const copy = prev.slice();
            copy[idx] = next;
            return copy;
          });
        })
        .finally(() => {
          if (inFlightRef.current.get(slug) === controller) {
            inFlightRef.current.delete(slug);
          }
        });
    },
    [policy.preload],
  );

  return { slots, handleSlotError };
}

/**
 * ポリシー取得を 1 セッションで 1 度だけにするためのモジュールローカルメモ化。
 * - SSR 時点では window が無いので保守的なデフォルトが返るが、
 *   クライアントマウント後にもう一度評価して上書きする。
 */
let memoPolicy: ReturnType<typeof getPrefetchPolicy> | null = null;
function getPrefetchPolicyMemo() {
  if (typeof window === "undefined") {
    // SSR は毎回保守的に返す (キャッシュしない)
    return getPrefetchPolicy();
  }
  if (memoPolicy === null) {
    memoPolicy = getPrefetchPolicy();
  }
  return memoPolicy;
}
