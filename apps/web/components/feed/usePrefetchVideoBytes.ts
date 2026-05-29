"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { MovieCard } from "@/lib/api/feed";
import {
  extractHost,
  inferQualityTier,
  pickPlaybackUrl,
  resolveMp4Url,
} from "@/lib/api/resolve-mp4";
import { ensurePreconnect, getPrefetchPolicy } from "@/lib/networkPrefs";
import { getMinStartTime } from "@/lib/proActress";
import { isVideoTimingEnabled } from "@/lib/videoTiming";
import {
  consumeJustClaimed,
  consumeStaleClaim,
  getReadiness,
  peekStaleClaim,
  syncNearProtection,
} from "@/lib/videoHandoff";

/**
 * 設計上の不変条件 (PR #196 で導入):
 *   readiness の source-of-truth は handoff registry 1 本に統合する。
 *   この hook はもう独自の slug→readiness 永続 Map (旧 readinessRef) を持たない。
 *
 * 過去の不整合 (entry-missing で readiness=canplay と表示されていたケース):
 *   - hidden <video> が canplay を発火 → readinessRef.set(slug, "canplay")
 *   - WINDOW_SIZE=1 で別 slug にスワイプ → FeedItem unmount → promoted <video>
 *     破棄 → registry entry が claim 済みで消滅
 *   - 直前 slug が再び +1..+3 に戻ってきたが、registry には新規 metadata 段階の
 *     entry しか無い (or まだ無い)
 *   - 旧 readinessRef は永続的に "canplay" を覚えていたため、active 化時の
 *     log で `byte-prefetched=canplay` と出るのに promote は不能で JSX <video>
 *     ゼロロードに落ちる。
 *
 * 修正方針:
 *   - readiness は常に getReadiness(slug) で registry から都度参照する。
 *   - 隠し <video> の loadedmetadata / canplay は PrefetchVideoBuffer 経由で
 *     updateReadiness が呼ばれ registry に集約される。本 hook の handleSlot* は
 *     後方互換用に残すが副作用は持たない (no-op)。
 *   - active セル / readiness window のログは registry の今を表示するだけ。
 *     entry が無ければ false、metadata なら metadata、canplay なら canplay。
 *     stale-claim signal (= 直前の tryClaim 失敗) は短命優先で reason を出す。
 */

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

/**
 * ユーザが上方向にスワイプして「直前まで見ていた」スライドへ戻ったときに、
 * ゼロロードからやり直さないために `current-1` のスライドも軽量に温めておく。
 * preload="metadata" 固定 (= container/codec/長さだけで bytes は取らない) で、
 * +1/+2 の bytes prefetch に帯域を譲りつつ、active 到達時の resolveMp4Url が
 * resolveCache にヒットして「resolve 1 往復+ <video> 初期化」分は短縮できる。
 *
 * 有効化条件: policy.aheadCount >= 1 (= 通常モードの回線/ブラウザ) かつ
 * rapid swipe 中でないこと。Save-Data / 2g (aheadCount=0) では実施しない。
 */
const PREV_PREFETCH_OFFSET = -1;

/**
 * handoff pool の near-protection に出す「近距離枠」の offset 範囲。
 * `current-1 .. current+3` を cap-eviction から守る。
 *
 * 注意: ここで保護する slug は実際に prefetch slot を持っているとは限らない。
 * Safari (aheadCount=1) や rapid swipe (+1 のみ allow) のように +2/+3 の slot を
 * 作らないモードでも、もし +2/+3 の entry がまだプールに残っていれば保護したい
 * (例: 直前まで +1 にいた slug が rapid swipe で active が動いて +2 へ後退した
 * 直後など)。そのため offset window は policy 非依存にして広めに取る。
 *
 * canplay 未到達 entry の枠 (MAX_POOLED_NON_CANPLAY=4) を圧迫しすぎないため
 * 上限は控えめ。`-1` 側は 1 枚だけ。
 */
const NEAR_PROTECT_MIN_OFFSET = -1;
const NEAR_PROTECT_MAX_OFFSET = 3;

/**
 * offset を `+1` / `-1` / `0` 形式の文字列に整形する。ログの "+" prefix を
 * 単純な ``+${offset}`` で組み立てると負数で `+-1` になるので分岐させる。
 */
function fmtOffset(offset: number): string {
  if (offset > 0) return `+${offset}`;
  if (offset === 0) return "0";
  return `${offset}`;
}

// current+1 は debounce なしで即時発火する。React のレンダー直後に走らせるため
// microtask (queueMicrotask 相当の Promise.resolve().then) でキックする。
// 中央 <video> がスワイプ確定するまでの数百 ms に競合しないよう、+1 だけは
// 「次に確実に表示される」優先扱いで遅延を入れない。

// current+1 以降のスロット (+2 など) は中央 <video> の安定再生を優先したいので
// 少し待ってから resolve する。ただし「rapid swipe が落ち着いた直後に +2 を温める
// 速度」が sub-1s 再生達成率に直結するので、過度には待たない。150ms は中央 <video>
// の resolve→loadstart より十分速く、かつ中央の Range request 開始と被って
// 帯域を奪うリスクが低い妥協値。
const UPCOMING_PREFETCH_DEBOUNCE_MS = 150;

function vtPrefetchLog(message: string) {
  if (!isVideoTimingEnabled()) return;
  // eslint-disable-next-line no-console
  console.debug(`vt byte-prefetch ${message}`);
}

/**
 * prefetch が選んだ URL の画質ティアを vt ログに残す。
 *
 * 不変条件: 隠し <video> と active <video> は同じ canonical URL を使うため、
 * ここで `quality` が `mhb` 以外になる場合は API が最高ビットレートとして
 * `_mhb_w.mp4` を返していない (= DMM 側でその作品は HD 候補が無い) ことを
 * 意味する。`drift=primary->high` は `high_mp4_url !== mp4_url` の作品で、
 * 旧実装が src-mismatch を出していたケース。
 */
function logPrefetchQuality(
  slug: string,
  res: { mp4_url: string; high_mp4_url?: string | null },
  picked: string,
  offset: number,
) {
  if (!isVideoTimingEnabled()) return;
  const tier = inferQualityTier(picked);
  const host = extractHost(picked);
  const drift =
    res.high_mp4_url && res.high_mp4_url !== res.mp4_url
      ? "primary->high"
      : "none";
  vtPrefetchLog(
    `quality slug=${slug} offset=${fmtOffset(offset)} quality=${tier} host=${host} drift=${drift}`,
  );
}

interface PrefetchSlot {
  /** key 用。MovieCard.id をそのまま使う */
  id: string;
  /** force re-resolve に使う */
  slug: string;
  /** <video src> に渡す URL */
  src: string;
  /**
   * 隠し <video> の preload 属性。
   * - "auto": bytes も含めて先頭バッファまで取得 (Chromium +1/+2)
   * - "metadata": container/codec/長さだけ取得しバイトは取らない
   *   (Safari +1, または Chromium +3 の "軽量ウォーミング")
   * - "none": ロードを完全に止める
   */
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
  /**
   * pro-actress 作品の先頭スキップ秒数 (= active 化時に currentTime をそこまで
   * 進める値)。隠し <video> はこの値を使って loadedmetadata 後に currentTime を
   * 先り設定し、browser に minStart 地点付近の Range も裏で取りに行かせる。
   * ノーマル作品は 0。
   */
  minStart: number;
}

interface Target {
  id: string;
  slug: string;
  offset: number;
  /** スロット作成時点で凍結する items index (currentIndex + offset)。 */
  targetIndex: number;
  /**
   * この target に使う preload mode。デフォルトは policy.preload。
   * +3 の "軽量ウォーミング" target は強制的に "metadata" を使い、bytes 取得は行わない。
   */
  preload: "auto" | "metadata" | "none";
  /**
   * pro-actress 作品の先頭スキップ秒数。`getMinStartTime(card.genres)` で算出される。
   */
  minStart: number;
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
  // effect 内から最新 slots を sync 読みするための ref (state 反映前に
  // 同 effect サイクルで複数 target を判定するため)。
  const slotsRef = useRef<PrefetchSlot[]>(slots);
  slotsRef.current = slots;
  // 進行中の resolveMp4Url を slug -> AbortController で管理。
  const inFlightRef = useRef<Map<string, AbortController>>(new Map());
  // 既に self-heal を 1 回試した slug。同 slug への無限リトライを防ぐ。
  const healedRef = useRef<Set<string>>(new Set());
  // slug -> MovieCard.id の逆引き。onError から slot を特定するため。
  const slugToIdRef = useRef<Map<string, string>>(new Map());
  const lastActiveSlugRef = useRef<string | null>(null);

  // ポリシー (aheadCount / preload / immediateUpcoming / warmPlusThree) を計算する。
  // effect 内で毎回読むと navigator アクセスが増えるので useEffect の中で 1 度だけ参照する。
  // 回線状況は途中で変わり得るが、本サイトは短時間セッションなので静的取得で十分。

  // 対象スライドの一覧 (id+slug+offset) を currentIndex / items から決める。
  // policy.aheadCount = 1 → +1 だけ / 2 → +1 と +2。
  // さらに policy.warmPlusThree=true なら +3 を preload="metadata" だけで足す。
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
      targets.push({
        id: it.id,
        slug: it.slug,
        offset,
        targetIndex: idx,
        preload: policy.preload,
        minStart: getMinStartTime(it.genres),
      });
    }
  }
  // +3 の軽量ウォーミング (bytes は取らない)。aheadCount で既に +3 を含む policy が
  // 出てきたら二重に積まないようガード。
  if (policy.warmPlusThree && policy.aheadCount < 3) {
    const offset = 3;
    const idx = currentIndex + offset;
    if (idx < items.length) {
      const it = items[idx];
      if (it && it.slug) {
        targets.push({
          id: it.id,
          slug: it.slug,
          offset,
          targetIndex: idx,
          // bytes を取らずに resolver 解決と <video> container 初期化だけ前倒し。
          preload: "metadata",
          minStart: getMinStartTime(it.genres),
        });
      }
    }
  }
  // current-1 の軽量ウォーミング。ユーザが上方向スワイプで「直前見ていた
  // スライド」に戻ったときに、resolveCache + <video> container だけでも
  // 温めておいて、ゼロロードからの force-load 動作を避ける。
  // aheadCount>=2 (= 通常モード: Chromium + 4G/WiFi 等) のときは canplay まで
  // 温めるために preload="auto" に格上げし、戻りスワイプ時に handoff pool 経由
  // で即 promote できるようにする。Safari (aheadCount=1) / Save-Data / 2G
  // (aheadCount=0) では bytes を取らず metadata 固定 (または slot 自体作らない)。
  // rapid swipe 中は activeTargets フィルタで除外される。
  if (policy.aheadCount > 0) {
    const offset = PREV_PREFETCH_OFFSET;
    const idx = currentIndex + offset;
    if (idx >= 0 && idx < items.length) {
      const it = items[idx];
      if (it && it.slug) {
        const prevPreload: "auto" | "metadata" =
          policy.aheadCount >= 2 ? "auto" : "metadata";
        targets.push({
          id: it.id,
          slug: it.slug,
          offset,
          targetIndex: idx,
          preload: prevPreload,
          minStart: getMinStartTime(it.genres),
        });
      }
    }
  }
  // deps 用に安定キーを生成 (id + preload + minStart の join)。
  // preload や minStart が変わると slot を作り直す (genres が遅れて送られてから minStart
  // が 0 → 5 になったケースも拾う)。
  const targetsKey = targets
    .map((t) => `${t.id}:${t.slug}:${t.offset}:${t.preload}:${t.minStart}`)
    .join("|");

  // active スライドが変わったタイミングで、そのスライドが裏 prefetch 済みだったかを
  // dev ログに出す。readiness は handoff registry を唯一の source-of-truth として
  // 都度参照する (= 上の不変条件)。
  //
  // FeedItem の useLayoutEffect (tryClaim) は本 effect より前に走るため、claim が
  // 成功していれば entry は registry から外れて getReadiness は null を返す。
  // この場合は claim 直後だけ true として扱う short-lived signal を別に消費する。
  //
  // window 内セル (+1..+3) は registry の今をそのまま映す。entry が無ければ false、
  // metadata なら metadata、canplay なら canplay。これにより「ログ上は canplay
  // なのに promote 不能」という乖離は構造的に発生しない。
  useEffect(() => {
    if (!isVideoTimingEnabled()) return;
    const activeItem = items[currentIndex];
    if (!activeItem || !activeItem.slug) return;
    if (lastActiveSlugRef.current === activeItem.slug) return;
    lastActiveSlugRef.current = activeItem.slug;
    // current セル:
    //   1) 直前の tryClaim 失敗 (stale signal) があれば最優先で false + 理由。
    //   2) 直前の tryClaim 成功 (justClaimed signal) があれば canplay
    //      (claim で entry が registry から消えたが promote 成立を意味する)。
    //   3) どちらも無ければ registry を直接読む。
    const stale = consumeStaleClaim(activeItem.slug);
    const justClaimed = stale === null && consumeJustClaimed(activeItem.slug);
    let activeLabel: "canplay" | "metadata" | "false";
    let activeReason: string | null = null;
    if (stale !== null) {
      activeLabel = "false";
      activeReason = `promote-${stale}`;
    } else if (justClaimed) {
      activeLabel = "canplay";
    } else {
      activeLabel = registryLabel(activeItem.slug);
    }
    if (activeReason) {
      vtPrefetchLog(
        `readiness stale slug=${activeItem.slug} reason=${activeReason}`,
      );
    }
    vtPrefetchLog(
      `active index=${currentIndex} slug=${activeItem.slug} byte-prefetched=${activeLabel}`,
    );
    // readiness window: current-1..+3。各セルとも registry を直接読む。
    // window セルでも stale-claim signal を peek (consume せず) して、立っている
    // 間は false 表示する。consume は当該 slug が active に来たときに行う。
    const cells: string[] = [];
    for (let d = NEAR_PROTECT_MIN_OFFSET; d <= NEAR_PROTECT_MAX_OFFSET; d += 1) {
      const idx = currentIndex + d;
      const it = idx >= 0 && idx < items.length ? items[idx] : null;
      const cellKey = d === 0 ? "current" : fmtOffset(d);
      if (!it || !it.slug) {
        cells.push(`${cellKey}=oob`);
        continue;
      }
      let label: string;
      if (d === 0) {
        label = activeLabel;
      } else if (peekStaleClaim(it.slug) !== null) {
        label = "false";
      } else {
        label = registryLabel(it.slug);
      }
      cells.push(`${cellKey}=${label}`);
    }
    vtPrefetchLog(`readiness window ${cells.join(" ")}`);
    if (activeLabel !== "canplay") {
      vtPrefetchLog(
        `active not-ready slug=${activeItem.slug} readiness=${activeLabel} index=${currentIndex}`,
      );
      // 緊急ウォームアップ (resolve cache only)。
      //
      // 不変条件: 「active が ready で無い瞬間」は、必ず active の resolve が
      // 走っているか、もしくは即時に kick する。useResolvedVideoSrc は FeedItem の
      // mount/enabled=true タイミングで動くが、ここで先回りすることで:
      //   - resolveCache (in-flight) を温める → useResolvedVideoSrc が onReuse で
      //     即ヒット → ネットワーク 1 往復ぶん早く着地。
      //   - +1 が false の場合は +1 の resolve も同時に高優先で kick して
      //     `byte-prefetch slot pending` から脱出させる。
      //
      // priority="high" 指定で、warm の "low" / 通常 prefetch の "normal" を
      // 飛び越えて global slot を確保する (resolve-mp4 側の bypass あり)。
      //
      // 注: ここで warm されるのは「resolveMp4Url の API レスポンス」だけで、
      // 動画バイトの先頭バッファは含まれない。active <video> 要素の Range request
      // が立ち上がるのは FeedItem の <video> マウント + load() に依存する。
      // 「active 要素は src 設定済みなのに rs=0 / networkState=0 のまま」固まる
      // ケースは useFeedPlayback の Phase 0 watchdog (load-kick) が hard-reset
      // で救済する。ここで重複して load() を撃つことはしない (videoRef を
      // 持たないし、ダブル kick は AbortError race を生む)。
      const nextItem =
        currentIndex + 1 < items.length ? items[currentIndex + 1] : null;
      const nextLabel = nextItem?.slug ? registryLabel(nextItem.slug) : "oob";
      vtPrefetchLog(
        `active emergency-current-resolve-warm slug=${activeItem.slug} current=${activeLabel} next=${nextLabel}`,
      );
      // active 自身は fire-and-forget で resolveCache を温めるだけ。
      // onReuse 経路は不要 (active 側の useResolvedVideoSrc が共有する)。
      void resolveMp4Url(activeItem.slug, { priority: "high" });
      if (
        nextItem &&
        nextItem.slug &&
        nextLabel !== "canplay" &&
        nextLabel !== "metadata"
      ) {
        // +1 が registry に entry 無し (= false) の場合のみ追加で kick。
        // metadata 以上なら既に隠し <video> が走っているので二重起動は不要。
        void resolveMp4Url(nextItem.slug, { priority: "high" });
      }
    }
  }, [currentIndex, items]);

  // current / +1 / +2 / +3 の slug を handoff registry の near-protected として
  // マーキングする。これで cap 超過時の eviction が遠距離 entry を優先するので、
  // 「rapid swipe で +1 entry が cap eviction → active 到達時 prefetched=false」
  // という事故が起きにくくなる。policy / rapid swipe とは独立して常に同期。
  useEffect(() => {
    const slugs: string[] = [];
    for (let d = NEAR_PROTECT_MIN_OFFSET; d <= NEAR_PROTECT_MAX_OFFSET; d += 1) {
      const idx = currentIndex + d;
      if (idx < 0 || idx >= items.length) continue;
      const it = items[idx];
      if (!it || !it.slug) continue;
      slugs.push(it.slug);
    }
    syncNearProtection(slugs);
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
    // rapid swipe 中で +1 のみ許可の場合は、それ以外の slot (-1/+2/+3) を evict して +1 用に空ける。
    setSlots((prev) => {
      if (activeTargets.length === 0) {
        return prev.length === 0 ? prev : [];
      }
      const wanted = new Set(activeTargets.map((t) => t.id));
      const filtered = prev.filter((s) => {
        const keep = wanted.has(s.id);
        if (!keep && isRapidSwiping && s.offset !== PREFETCH_START_OFFSET) {
          vtPrefetchLog(
            `evict offset=${fmtOffset(s.offset)} slug=${s.slug} for ${fmtOffset(PREFETCH_START_OFFSET)} (rapid)`,
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

    // 発火タイミング:
    //   - +1 は常に debounce 無しで即時発火 (rapid swipe 中も含む)。
    //   - +2/+3 は policy.immediateUpcoming=true (Chromium+4G/wifi) なら即時、
    //     それ以外は UPCOMING_PREFETCH_DEBOUNCE_MS だけ遅延。
    //     rapid 中は activeTargets から +2/+3 が除外されているので発火しない。
    const nextTarget = activeTargets.find((t) => t.offset === PREFETCH_START_OFFSET);
    // +1 以外 (つまり +2/+3 / -1) は「中央以外の軽量ターゲット」。
    // policy.immediateUpcoming に合わせて 即時 / debounce で発火する。
    const upcomingTargets = activeTargets.filter((t) => t.offset !== PREFETCH_START_OFFSET);

    const fire = (target: Target, immediate: boolean) => {
      // 既に同 id/slug/preload の slot がある (= 既に preload 中の <video> 要素が
      // handoff registry に温まっている) ならば、resolve は再発火しない。
      // ただし offset / targetIndex が変わっていれば更新する (例: +2 で立てた slot が
      // active 前進で +1 に繰り上がる)。これをしないと vt の slot ログが古い offset
      // のまま残り、「+1 slot 不在」に見えてしまう。
      const existingSlot = slotsRef.current.find((s) => s.id === target.id);
      if (
        existingSlot &&
        existingSlot.slug === target.slug &&
        existingSlot.preload === target.preload &&
        existingSlot.minStart === target.minStart
      ) {
        if (
          existingSlot.offset !== target.offset ||
          existingSlot.targetIndex !== target.targetIndex
        ) {
          // offset の繰り上がり (例: +2 → +1) を slot に反映し、active が claim
          // しに来た時に readiness window で「+1 はあるが既存 entry を再利用」
          // と読めるようにする。
          vtPrefetchLog(
            `slot promote-offset slug=${target.slug} from=${fmtOffset(existingSlot.offset)} to=${fmtOffset(target.offset)} index=${target.targetIndex}`,
          );
          setSlots((prev) => {
            const idx = prev.findIndex((s) => s.id === target.id);
            if (idx === -1) return prev;
            const cur = prev[idx];
            if (
              cur.offset === target.offset &&
              cur.targetIndex === target.targetIndex
            ) {
              return prev;
            }
            const copy = prev.slice();
            copy[idx] = {
              ...cur,
              offset: target.offset,
              targetIndex: target.targetIndex,
            };
            return copy;
          });
        } else {
          vtPrefetchLog(
            `slot reuse index=${target.targetIndex} slug=${target.slug} offset=${fmtOffset(target.offset)}`,
          );
        }
        return;
      }
      if (inFlight.has(target.slug)) {
        // 直前 cycle で resolve を始めたがまだ slot に push されていない状態
        // (resolve 完了前 / 隠し <video> 要素も未登録)。+1 がここに来ると active
        // 到達時に readiness=false で待たされる。発生を観測するための診断ログ。
        vtPrefetchLog(
          `slot pending offset=${fmtOffset(target.offset)} slug=${target.slug} index=${target.targetIndex} reason=resolve-in-flight`,
        );
        return;
      }
      const controller = new AbortController();
      inFlight.set(target.slug, controller);
      if (isRapidSwiping && target.offset === PREFETCH_START_OFFSET) {
        vtPrefetchLog(
          `rapid allow ${fmtOffset(target.offset)} slug=${target.slug} index=${target.targetIndex}`,
        );
      }
      vtPrefetchLog(
        `slot index=${target.targetIndex} slug=${target.slug} offset=${fmtOffset(target.offset)} mode=${target.preload} immediate=${immediate}`,
      );
      void resolveMp4Url(target.slug, {
        signal: controller.signal,
        priority: "normal",
      })
        .then((res) => {
          if (controller.signal.aborted) return;
          if (!res?.mp4_url) return;
          // active (useResolvedVideoSrc) と同じ canonical URL を使う。
          // ここで `res.mp4_url` (= API primary = args.src) ではなく
          // `pickPlaybackUrl(res)` (= high_mp4_url || mp4_url) を採用しないと、
          // 隠し <video> に貼る src と active <video> の src が不一致になり、
          // videoHandoff レジストリの src 比較で `promote-src-mismatch` が
          // 出続けて handoff が成立しない (＝ prefetch 帯域が無駄に消費されて
          // active の高画質取得を遅らせる)。
          const url = pickPlaybackUrl(res);
          logPrefetchQuality(target.slug, res, url, target.offset);
          // 解決した CDN origin に dyn preconnect (TCP/TLS handshake を前倒し)。
          ensurePreconnect(url);
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
                src: url,
                preload: target.preload,
                offset: target.offset,
                targetIndex: target.targetIndex,
                minStart: target.minStart,
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
    // policy.immediateUpcoming=true なら +2/+3 も同じ effect tick で即時発火。
    // (Chromium+4G/wifi では中央 <video> の Range request 開始と被ってもボトルネックに
    //  なりにくく、150ms 待つと rapid swipe 突入時に +2 が canplay まで温まらない。)
    let upcomingTimer: ReturnType<typeof setTimeout> | null = null;
    if (upcomingTargets.length > 0) {
      if (policy.immediateUpcoming) {
        for (const target of upcomingTargets) fire(target, true);
      } else {
        upcomingTimer = setTimeout(() => {
          for (const target of upcomingTargets) fire(target, false);
        }, UPCOMING_PREFETCH_DEBOUNCE_MS);
      }
    }

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
          // self-heal 後も active と同じ canonical URL を使う (src-mismatch 防止)。
          const url = pickPlaybackUrl(res);
          ensurePreconnect(url);
          const id = slugToIdRef.current.get(slug);
          if (!id) return; // 既に対象範囲外
          setSlots((prev) => {
            const idx = prev.findIndex((s) => s.id === id);
            // 既存スロットがあれば作成時の offset/targetIndex/preload を保持 (ログ drift 防止)。
            // +3 の metadata-only スロットを self-heal で auto に格上げしないため、
            // 既存スロットの preload は維持する。
            const existing = idx >= 0 ? prev[idx] : null;
            const existingOffset = existing?.offset ?? PREFETCH_START_OFFSET;
            const existingTargetIndex = existing?.targetIndex ?? -1;
            const existingPreload = existing?.preload ?? policy.preload;
            const existingMinStart = existing?.minStart ?? 0;
            const next: PrefetchSlot = {
              id,
              slug,
              src: url,
              preload: existingPreload,
              offset: existingOffset,
              targetIndex: existingTargetIndex,
              minStart: existingMinStart,
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

  // 後方互換のために残す no-op handler。registry への readiness 反映は
  // PrefetchVideoBuffer 側で updateReadiness が直接呼ばれているので、本 hook では
  // 何も覚えない (= 「永続的に canplay と覚え続ける ref」問題を構造的に排除する)。
  const handleSlotMetadata = useCallback((_slug: string) => {
    // no-op (registry が source-of-truth)
  }, []);
  const handleSlotCanPlay = useCallback((_slug: string) => {
    // no-op (registry が source-of-truth)
  }, []);

  return { slots, handleSlotError, handleSlotMetadata, handleSlotCanPlay };
}

/**
 * registry を唯一の真実として読む。
 *   - entry なし → "false"
 *   - entry readiness="metadata" → "metadata"
 *   - entry readiness="canplay" → "canplay"
 */
function registryLabel(slug: string): "canplay" | "metadata" | "false" {
  const r = getReadiness(slug);
  if (r === "canplay") return "canplay";
  if (r === "metadata") return "metadata";
  return "false";
}

/**
 * ポリシー取得を 1 セッションで 1 度だけにするためのモジュールローカルメモ化。
 * - SSR 時点では window が無いので保守的なデフォルトが返るが、
 *   クライアントマウント後にもう一度評価して上書きする。
 * - クライアントで初めて評価されたタイミングで vt ログを 1 行出して、運用者が
 *   「今のセッションは +2 即時 / +3 metadata warming が有効なのか」を確認できるようにする。
 */
let memoPolicy: ReturnType<typeof getPrefetchPolicy> | null = null;
let policyLogged = false;
function getPrefetchPolicyMemo() {
  if (typeof window === "undefined") {
    // SSR は毎回保守的に返す (キャッシュしない)
    return getPrefetchPolicy();
  }
  if (memoPolicy === null) {
    memoPolicy = getPrefetchPolicy();
  }
  if (!policyLogged) {
    policyLogged = true;
    vtPrefetchLog(
      `policy ahead=${memoPolicy.aheadCount} preload=${memoPolicy.preload} immediateUpcoming=${memoPolicy.immediateUpcoming} warmPlusThree=${memoPolicy.warmPlusThree} reason=${memoPolicy.reason}`,
    );
  }
  return memoPolicy;
}
