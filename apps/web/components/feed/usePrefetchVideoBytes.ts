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

// current+1 は debounce なしで即時発火する。React のレンダー直後に走らせるため
// microtask (queueMicrotask 相当の Promise.resolve().then) でキックする。
// 中央 <video> がスワイプ確定するまでの数百 ms に競合しないよう、+1 だけは
// 「次に確実に表示される」優先扱いで遅延を入れない。

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
  /**
   * dev ログ用: スロット作成時点の currentIndex からのオフセット (+1, +2 など)。
   * active が後から動いてもこの値は更新しない (作成時のスナップショット)。
   */
  offset: number;
  /**
   * dev ログ用: スロット作成時点で「このスロットがどの items index を狙っているか」を
   * 凍結した値。currentIndex + offset (作成時) と同義。後から active が動いても
   * このスロットのログには常に同じ index が出る。
   */
  targetIndex: number;
}

interface Target {
  id: string;
  slug: string;
  offset: number;
  /** スロット作成時点で凍結する items index (currentIndex + offset)。 */
  targetIndex: number;
}

export type PrefetchReadiness = "metadata" | "canplay";

export function usePrefetchVideoBytes(
  items: MovieCard[],
  currentIndex: number,
  isRapidSwiping: boolean = false,
): {
  slots: PrefetchSlot[];
  handleSlotError: (slug: string) => void;
  handleSlotMetadata: (slug: string) => void;
  handleSlotCanPlay: (slug: string) => void;
} {
  const [slots, setSlots] = useState<PrefetchSlot[]>([]);
  // 進行中の resolveMp4Url を slug -> AbortController で管理。
  const inFlightRef = useRef<Map<string, AbortController>>(new Map());
  // 既に self-heal を 1 回試した slug。同 slug への無限リトライを防ぐ。
  const healedRef = useRef<Set<string>>(new Set());
  // slug -> MovieCard.id の逆引き。onError から slot を特定するため。
  const slugToIdRef = useRef<Map<string, string>>(new Map());
  // dev ログ用: 隠し <video> が到達した readiness レベルを slug 単位で覚えておき、
  // active 移動時に loadedmetadata だけ届いたのか canplay まで温まっていたのかを
  // active ログに反映する。一度 canplay まで上がったら metadata には戻さない。
  const readinessRef = useRef<Map<string, PrefetchReadiness>>(new Map());
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
      targets.push({ id: it.id, slug: it.slug, offset, targetIndex: idx });
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
    const readiness = readinessRef.current.get(activeItem.slug);
    // 旧 boolean からの移行: canplay > metadata > false。
    // Chrome の +1 (auto) は canplay 到達まで「真の prefetched」と認めず、
    // active 到達時には canplay / metadata / false の 3 段階で出す。
    const readinessLabel: string = readiness ?? "false";
    vtPrefetchLog(
      `active index=${currentIndex} slug=${activeItem.slug} byte-prefetched=${readinessLabel}`,
    );
  }, [currentIndex, items]);

  useEffect(() => {
    const inFlight = inFlightRef.current;
    const slugToId = slugToIdRef.current;

    // rapid swipe 中は current+1 のみを許可し、+2/+3 は targets から外して
    // slot を確実に +1 用に解放する。policy.aheadCount=0 (Save-Data / 2g) の
    // ときは targets が空のままなのでこの分岐でも何も足さない。
    const activeTargets =
      isRapidSwiping && targets.length > 0
        ? targets.filter((t) => t.offset === PREFETCH_START_OFFSET)
        : targets;

    // slug -> id 逆引きを更新 (activeTargets ベース)
    slugToId.clear();
    for (const t of activeTargets) {
      slugToId.set(t.slug, t.id);
    }

    // スクロール中 / Save-Data 等で targets が空のとき: slots と進行中 resolve をクリアして
    // 隠し <video> をアンマウントし、中央の <video> への帯域集中を保つ。
    // rapid swipe 中で +1 のみ許可の場合は、+2/+3 の slot を evict して +1 用に空ける。
    setSlots((prev) => {
      if (activeTargets.length === 0) {
        return prev.length === 0 ? prev : [];
      }
      const wanted = new Set(activeTargets.map((t) => t.id));
      const filtered = prev.filter((s) => {
        const keep = wanted.has(s.id);
        if (!keep && isRapidSwiping && s.offset > PREFETCH_START_OFFSET) {
          vtPrefetchLog(
            `evict offset=+${s.offset} slug=${s.slug} for +${PREFETCH_START_OFFSET} (rapid)`,
          );
        }
        return keep;
      });
      return filtered.length === prev.length ? prev : filtered;
    });

    // target から外れた slug の進行中 resolve は abort。
    // rapid 中は +2/+3 の resolve も abort して +1 の帯域に譲る。
    const targetSlugs = new Set(activeTargets.map((t) => t.slug));
    for (const [slug, controller] of inFlight.entries()) {
      if (!targetSlugs.has(slug)) {
        controller.abort();
        inFlight.delete(slug);
      }
    }

    if (activeTargets.length === 0) {
      return;
    }

    // current+1 は debounce なしで即時発火 (rapid swipe 中も含む)。
    // +2 以降は中央 <video> 安定再生のため少し遅らせる (rapid 中は activeTargets に
    // 含まれないので発火しない)。
    const nextTarget = activeTargets.find((t) => t.offset === PREFETCH_START_OFFSET);
    const upcomingTargets = activeTargets.filter((t) => t.offset > PREFETCH_START_OFFSET);

    const fire = (target: Target, immediate: boolean) => {
      if (inFlight.has(target.slug)) return;
      const controller = new AbortController();
      inFlight.set(target.slug, controller);
      if (isRapidSwiping && target.offset === PREFETCH_START_OFFSET) {
        vtPrefetchLog(
          `rapid allow +${target.offset} slug=${target.slug} index=${target.targetIndex}`,
        );
      }
      vtPrefetchLog(
        `slot index=${target.targetIndex} slug=${target.slug} offset=+${target.offset} mode=${policy.preload} immediate=${immediate}`,
      );
      void resolveMp4Url(target.slug, {
        signal: controller.signal,
        priority: "normal",
      })
        .then((res) => {
          if (controller.signal.aborted) return;
          if (!res?.mp4_url) return;
          // 解決した CDN origin に dyn preconnect (TCP/TLS handshake を前倒し)。
          ensurePreconnect(res.mp4_url);
          // readiness は隠し <video> の loadedmetadata / canplay を待って判定する
          // (resolve 成功時点ではまだバイトを取り始めてさえいない可能性があるため)。
          setSlots((prev) => {
            // 既に同 id slot があれば差し替え不要。それ以外は +1 を最優先で push。
            if (prev.some((s) => s.id === target.id)) return prev;
            return [
              ...prev,
              {
                id: target.id,
                slug: target.slug,
                src: res.mp4_url,
                preload: policy.preload,
                offset: target.offset,
                targetIndex: target.targetIndex,
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

    // +1 は同期的に即時発火する (effect 内 = React コミット直後)。
    // microtask へのキューイングはせず、resolveMp4Url を即呼び出してネットワークを
    // 1 tick でも早くキックする。これにより active が +1 を claim できる確率
    // (canplay 到達済み) が上がる。
    if (nextTarget) {
      fire(nextTarget, true);
    }
    const upcomingTimer =
      upcomingTargets.length > 0
        ? setTimeout(() => {
            for (const target of upcomingTargets) fire(target, false);
          }, UPCOMING_PREFETCH_DEBOUNCE_MS)
        : null;

    return () => {
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

      void resolveMp4Url(slug, {
        force: true,
        signal: controller.signal,
        priority: "high",
      })
        .then((res) => {
          if (controller.signal.aborted) return;
          if (!res?.mp4_url) return;
          ensurePreconnect(res.mp4_url);
          const id = slugToIdRef.current.get(slug);
          if (!id) return; // 既に対象範囲外
          setSlots((prev) => {
            const idx = prev.findIndex((s) => s.id === id);
            // 既存スロットがあれば作成時の offset/targetIndex を保持 (ログ drift 防止)。
            const existing = idx >= 0 ? prev[idx] : null;
            const existingOffset = existing?.offset ?? PREFETCH_START_OFFSET;
            const existingTargetIndex = existing?.targetIndex ?? -1;
            const next: PrefetchSlot = {
              id,
              slug,
              src: res.mp4_url,
              preload: policy.preload,
              offset: existingOffset,
              targetIndex: existingTargetIndex,
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

  // 隠し <video> が loadedmetadata を発火したら readiness を 'metadata' に格上げ。
  // 一度 'canplay' まで到達した slug は格下げしない (canplay >= metadata)。
  const handleSlotMetadata = useCallback((slug: string) => {
    if (!slug) return;
    const cur = readinessRef.current.get(slug);
    if (cur === "canplay") return;
    readinessRef.current.set(slug, "metadata");
  }, []);

  // 隠し <video> が canplay (readyState >= HAVE_FUTURE_DATA) に到達したら
  // readiness を 'canplay' に格上げ。これが Chrome の +1 で「真の prefetched」と
  // 認める閾値。Safari は preload="metadata" のままなので通常ここには来ない。
  const handleSlotCanPlay = useCallback((slug: string) => {
    if (!slug) return;
    readinessRef.current.set(slug, "canplay");
  }, []);

  return { slots, handleSlotError, handleSlotMetadata, handleSlotCanPlay };
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
