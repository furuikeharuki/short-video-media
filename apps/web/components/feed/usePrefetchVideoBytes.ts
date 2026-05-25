"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { MovieCard } from "@/lib/api/feed";
import { resolveMp4Url } from "@/lib/api/resolve-mp4";
import { ensurePreconnect, getPrefetchPolicy } from "@/lib/networkPrefs";

/**
 * 現在再生中のスライドより先 N 枚分の動画バイトを裏で preload しておく hook。
 *
 * 背景:
 *   - WINDOW_SIZE=1 (中央 + 隣接 2 枚) で isAdjacent の <video> が currentIndex±1 の
 *     バイトを直接 preload するため、この hook は currentIndex+2 以降を担当する。
 *   - ブラウザに応じて先読み枚数を変える:
 *       * Chrome / Chromium: currentIndex+2 と +3 の 2 枚を bytes 先読み
 *       * Safari / iOS Safari: currentIndex+2 のみ、preload="metadata" でメタデータだけ取得
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
 * 「次の次」から先読みを始める (隣接スライドは中央±1 なので +2 が次に中央になるスライド)。
 * 実際に何枚先まで読むかは getPrefetchPolicy() に従い、ブラウザと回線で決める。
 */
const PREFETCH_START_OFFSET = 2;

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
  /** 隠し <video> の preload 属性 (Safari は "metadata", Chrome は "auto") */
  preload: "auto" | "metadata" | "none";
}

interface Target {
  id: string;
  slug: string;
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

  // ポリシー (aheadCount / preload) を計算する。effect 内で毎回読むと
  // navigator アクセスが増えるので useEffect の中で 1 度だけ参照する。
  // 回線状況は途中で変わり得るが、本サイトは短時間セッションなので静的取得で十分。

  // 対象スライドの一覧 (id+slug) を currentIndex / items から決める。
  // policy.aheadCount = 1 → +2 だけ / 2 → +2 と +3。
  // ここで targets を実 effect が走る前に算出しておくと、deps として安定 key (id 連結) を使える。
  const policy = getPrefetchPolicyMemo();
  const targets: Target[] = [];
  if (policy.aheadCount > 0) {
    for (let i = 0; i < policy.aheadCount; i += 1) {
      const idx = currentIndex + PREFETCH_START_OFFSET + i;
      if (idx >= items.length) break;
      const it = items[idx];
      if (!it || !it.slug) continue;
      targets.push({ id: it.id, slug: it.slug });
    }
  }
  // deps 用に安定キーを生成 (id の join)。
  const targetsKey = targets.map((t) => `${t.id}:${t.slug}`).join("|");

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

    // currentIndex が PREFETCH_DEBOUNCE_MS の間変わらなかったら resolve + slot 化。
    const timer = setTimeout(() => {
      for (const target of targets) {
        if (inFlight.has(target.slug)) continue;
        const controller = new AbortController();
        inFlight.set(target.slug, controller);
        void resolveMp4Url(target.slug, { signal: controller.signal })
          .then((res) => {
            if (controller.signal.aborted) return;
            if (!res?.mp4_url) return;
            // 解決した CDN origin に dyn preconnect (TCP/TLS handshake を前倒し)。
            ensurePreconnect(res.mp4_url);
            setSlots((prev) => {
              if (prev.some((s) => s.id === target.id)) return prev;
              return [
                ...prev,
                {
                  id: target.id,
                  slug: target.slug,
                  src: res.mp4_url,
                  preload: policy.preload,
                },
              ];
            });
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
    // targetsKey / isRapidSwiping / policy.preload・aheadCount が変わったときに走り直す。
    // targets は毎レンダー新オブジェクトなので key 化した文字列を使う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetsKey, isRapidSwiping, policy.preload, policy.aheadCount]);

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
            const next: PrefetchSlot = {
              id,
              slug,
              src: res.mp4_url,
              preload: policy.preload,
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
