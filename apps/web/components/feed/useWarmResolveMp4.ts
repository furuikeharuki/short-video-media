"use client";

import { useEffect, useRef } from "react";

import type { MovieCard } from "@/lib/api/feed";
import { resolveMp4Url } from "@/lib/api/resolve-mp4";
import { getPrefetchPolicy } from "@/lib/networkPrefs";
import { isVideoTimingEnabled } from "@/lib/videoTiming";

/**
 * 遠距離 (current+WARM_START..+WARM_END) を低優先度で「温める」hook。
 *
 * 目的:
 *   resolver (DMM html5_player) は uncached で 3〜4 秒かかることが多く、
 *   `usePrefetchResolveMp4` の +1..+5 だけでは「ユーザーが連続スワイプで
 *   +6 以降に到達したとき URL がまだ取れていない」状態になりがち。
 *   本 hook は currentIndex+6..+15 をバックグラウンドで先行 resolve し、
 *   resolveCache (`resolveMp4Url` 内) に貯めておくことで、近距離 prefetch /
 *   active 再生が来たときには即キャッシュヒットさせる。
 *
 * 設計:
 *   - 共通の `resolveMp4Url` を使うため、近距離 prefetch / active 再生と
 *     完全に同じ in-flight デデュープ + resolveCache に乗る。
 *     片方が走っていればもう片方は即タダ乗り。
 *   - 同時実行は 2 本まで (WARM_CONCURRENCY)。近距離 prefetch を邪魔しないよう
 *     warm 専用のローカルキューで絞る (resolveMp4Url 側のグローバル
 *     `MAX_CONCURRENT_FETCHES=8` の中で 2 枠を消費する形)。
 *   - rapid swipe 中 / Save-Data / 2g・slow-2g は完全停止 (近距離 prefetch と
 *     同じ判定を `getPrefetchPolicy().aheadCount === 0` で借用)。
 *   - currentIndex が変わったら、新窓に入っていない warm ジョブは abort/skip。
 *   - 同一 slug の resolve 成功は記憶し、再スケジュールしない。失敗は
 *     `FAILURE_TTL_MS` 後に再試行可能に戻す (近距離 prefetch と同方針)。
 *   - ログは `?vt=1` 時のみ。1 スケジューリングで実際に start/skip した
 *     ものだけ出す (毎レンダーで吐かない)。
 */

const WARM_START = 6;
const WARM_END = 15;
const WARM_CONCURRENCY = 2;
const FAILURE_TTL_MS = 30_000;
/**
 * バッチ内の各 warm resolve 起動間に挟む小休止。
 * 解決済みなら 0 ms 即ヒットだが、未解決のときに 2 本同時 + 隣接 prefetch が
 * 重なるとサーバ側の DMM html5_player 取得が混んで 504 になりやすいので、
 * バッチを少しズラして体感の帯域を残す。
 */
const WARM_STAGGER_MS = 150;

function vtWarmLog(message: string) {
  if (!isVideoTimingEnabled()) return;
  // eslint-disable-next-line no-console
  console.debug(`vt warm ${message}`);
}

export function useWarmResolveMp4(
  items: MovieCard[],
  currentIndex: number,
  isRapidSwiping: boolean = false,
): void {
  /** 現在 warm-resolve 中の slug → controller。currentIndex 変化で外れたら abort。 */
  const inFlightRef = useRef<Map<string, AbortController>>(new Map());
  /** resolve 成功して mp4_url を取れた slug。重複スケジューリング抑制用。 */
  const resolvedSlugsRef = useRef<Set<string>>(new Set());
  /** 直近 resolve が失敗 (null) した slug → 失敗時刻 (ms)。TTL 経過で再試行可能に戻る。 */
  const failedSlugsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const inFlight = inFlightRef.current;
    const resolved = resolvedSlugsRef.current;
    const failed = failedSlugsRef.current;

    // Save-Data / 2g / slow-2g なら近距離 prefetch も止まる。warm も完全停止する。
    const policy = getPrefetchPolicy();
    if (policy.aheadCount === 0) {
      // 既存 in-flight は新窓外と同じ扱いで abort してしまって良い。
      for (const [slug, controller] of inFlight.entries()) {
        controller.abort();
        inFlight.delete(slug);
      }
      vtWarmLog(`resolve skip data-saver reason=${policy.reason}`);
      return;
    }

    // 高速スワイプ中は warm を一切走らせない。近距離 prefetch / active の帯域を譲る。
    if (isRapidSwiping) {
      for (const [slug, controller] of inFlight.entries()) {
        controller.abort();
        inFlight.delete(slug);
      }
      vtWarmLog(`resolve skip rapid`);
      return;
    }

    const isAlreadyHandled = (slug: string): boolean => {
      if (resolved.has(slug)) return true;
      const failedAt = failed.get(slug);
      if (failedAt !== undefined) {
        if (Date.now() - failedAt < FAILURE_TTL_MS) return true;
        failed.delete(slug);
      }
      return false;
    };

    // current+WARM_START..+WARM_END を対象に組み立てる。slug 重複は除去。
    type Target = { slug: string; offset: number; index: number };
    const seenSlugs = new Set<string>();
    const targets: Target[] = [];
    for (let offset = WARM_START; offset <= WARM_END; offset += 1) {
      const idx = currentIndex + offset;
      if (idx < 0 || idx >= items.length) continue;
      const item = items[idx];
      if (!item || !item.slug) continue;
      if (seenSlugs.has(item.slug)) continue;
      seenSlugs.add(item.slug);
      targets.push({ slug: item.slug, offset, index: idx });
    }
    const newTargetSlugs = new Set(targets.map((t) => t.slug));

    // 新窓外になった warm 進行中ジョブは abort。
    for (const [slug, controller] of inFlight.entries()) {
      if (!newTargetSlugs.has(slug)) {
        controller.abort();
        inFlight.delete(slug);
      }
    }

    // 実行候補: in-flight でも resolved でも failed-TTL 内でもないもの。
    const pending: Target[] = [];
    for (const t of targets) {
      if (inFlight.has(t.slug)) continue;
      if (isAlreadyHandled(t.slug)) {
        vtWarmLog(
          `resolve skip cached index=${t.index} offset=+${t.offset} slug=${t.slug}`,
        );
        continue;
      }
      pending.push(t);
    }
    if (pending.length === 0) return;

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    /** warm 専用の同時実行カウンタ。最大 WARM_CONCURRENCY。 */
    let running = 0;
    let nextIdx = 0;

    const fire = (target: Target) => {
      if (cancelled) return;
      if (inFlight.has(target.slug)) return;
      // 起動直前に rapid / resolved / failed-TTL に転んだ可能性を再チェック。
      if (isAlreadyHandled(target.slug)) {
        vtWarmLog(
          `resolve skip cached index=${target.index} offset=+${target.offset} slug=${target.slug}`,
        );
        pump();
        return;
      }
      const controller = new AbortController();
      inFlight.set(target.slug, controller);
      running += 1;
      vtWarmLog(
        `resolve start index=${target.index} offset=+${target.offset} slug=${target.slug}`,
      );
      void resolveMp4Url(target.slug, { signal: controller.signal })
        .then((res) => {
          if (controller.signal.aborted) return;
          const got = !!res?.mp4_url;
          if (got) {
            resolved.add(target.slug);
            failed.delete(target.slug);
          } else {
            failed.set(target.slug, Date.now());
          }
          vtWarmLog(
            `resolve ok index=${target.index} offset=+${target.offset} slug=${target.slug} got=${got}`,
          );
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          failed.set(target.slug, Date.now());
          vtWarmLog(
            `resolve fail index=${target.index} offset=+${target.offset} slug=${target.slug}`,
          );
        })
        .finally(() => {
          if (inFlight.get(target.slug) === controller) {
            inFlight.delete(target.slug);
          }
          running -= 1;
          pump();
        });
    };

    /** WARM_CONCURRENCY 枠まで埋めるディスパッチャ。 */
    const pump = () => {
      if (cancelled) return;
      while (running < WARM_CONCURRENCY && nextIdx < pending.length) {
        const target = pending[nextIdx];
        nextIdx += 1;
        // 2 本目以降は少しスタガーを挟んで一気にバーストしない。
        if (running === 0 && nextIdx === 1) {
          fire(target);
        } else {
          const t = setTimeout(() => fire(target), WARM_STAGGER_MS);
          timers.push(t);
        }
      }
    };

    pump();

    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
  }, [items, currentIndex, isRapidSwiping]);

  // アンマウント時は全 warm を abort。
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
