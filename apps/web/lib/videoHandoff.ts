/**
 * 隠し prefetch <video> 要素を active 表示にそのまま流用する (要素 handoff) ための
 * 軽量レジストリ + 短命プール。
 *
 * 背景:
 *   - `PrefetchVideoBuffer` が画面外でメディアバイトを温めても、active 側で
 *     別の <video> 要素に同じ src を貼ると、Chrome/Safari ともに新規 GET
 *     (もしくは Range request 再発行) が走り、loadedmetadata まで数秒待たされる
 *     ケースが多発する (vt ログで +9s 観測)。
 *   - 同じ要素を中央スライドに流用すれば、すでに decoded buffer / readyState を
 *     保持したまま再生開始できる。
 *
 * 設計:
 *   - <video> は React の reconciler 外で `document.createElement("video")` で
 *     作る。これにより親コンポーネントがアンマウントされても DOM ノードを
 *     物理的に他の親へ append できる。
 *   - レジストリは slug をキーにする。+1 / +2 などの slot/offset には依存しない。
 *     active 側は「現在表示すべき slug + src」で claim できる。
 *   - PrefetchVideoBuffer の slot が +1/+2 から外れて unmount されても、要素が
 *     canplay 済みなら長め TTL、metadata/loading 段階でも短命 TTL でプールへ
 *     移管する。これにより rapid swipe で slot 構成が頻繁に入れ替わっても、
 *     in-progress な隠し要素が即座に捨てられず、その後 active になった slug が
 *     canplay 到達を待って promote できる。
 *   - 解放優先度:
 *       1) 同 slug の register/evict 要求があれば即破棄。
 *       2) プール枠が cap を超えるとき、readiness が低い (metadata 未満) ものを
 *          最古順に破棄。canplay 済みは最後まで残す。
 *       3) TTL を超えた entry は背景クリーンアップで破棄。canplay は長め TTL、
 *          metadata 以下は短命 TTL。
 *   - claim 済みエントリは即座にレジストリから外し、prefetch buffer も slot から
 *     除去させる (usePrefetchVideoBytes が onClaim 経由で自身の slots を更新)。
 *
 * SSR セーフ: モジュールロード時は何もしない。registry の操作は呼出側が
 * クライアント (useEffect 内) 経由でしか触らない前提。
 */

import { isVideoTimingEnabled } from "@/lib/videoTiming";
import { tailStartForDuration } from "@/lib/proActress";

export type HandoffReadiness = "metadata" | "canplay";

interface HandoffEntry {
  slug: string;
  src: string;
  el: HTMLVideoElement;
  readiness: HandoffReadiness;
  /** プールに入った時刻 (registerPrefetchElement または releasePrefetchElement→retain)。 */
  pooledAt: number;
  /**
   * 現在 PrefetchVideoBuffer が所有していれば false。
   * buffer が unmount したが destroy せずプールに retain しているときは true。
   */
  detached: boolean;
  /**
   * active 側が pending-handoff として claim 中の slug ならピンされる。
   * pin されている間は cap / TTL のクリーンアップで evict されない。
   * 解除は promote / abandon / slug-change を起こした active 側が行う。
   */
  pinned: boolean;
  /**
   * 「active からの距離が近い (current/+1/+2/+3) 未来枠」として保護されている。
   *
   * pin (= pending claim) ほど強くないが、cap 超過時の eviction では near-protected
   * を後回しにする。これにより、rapid swipe で隠し <video> の slot 構成が頻繁に
   * 入れ替わっても、近い未来 (まだ canplay 未到達でも数百 ms 以内に active になり
   * 得る) の entry が generic cap の最古順 eviction で巻き込まれるのを防ぐ。
   *
   * 設定は prefetch hook 側が `setNearProtected(slug, true)` で行い、slot が
   * 抜けたタイミングで false にする。pin と異なり TTL は通常通り作用する
   * (canplay = 長 / pending = 短)。
   */
  nearProtected: boolean;
  /**
   * プール retain 中だけ <video> 要素に貼っておく readiness リスナ群。
   *
   * `PrefetchVideoBuffer` が unmount すると、buffer 側で attach されていた
   * loadedmetadata/canplay リスナは cleanup で全て外れる。一方で要素自体は
   * `releasePrefetchElement` でプールに retain されたまま、画面外で
   * preload を継続する。
   *
   * このとき残骸 entry の readiness を最新に保たないと:
   *   - 同 slug が再び +1/+2 に来て fire() が呼ばれても、registry の readiness が
   *     metadata のまま固まり、active 到達時の `tryClaim` が
   *     `not-canplay → markStaleClaim → host-only-deadlock → force-fallback` の
   *     経路に落ちる。
   * これを防ぐため、retain 時に pool 自身が `loadedmetadata` / `canplay` を
   * subscribe し、registry 側で updateReadiness を呼ぶ。
   *
   * register/claim/destroy/evict 時には必ず detach する (二重発火防止)。
   */
  poolListeners: PoolListeners | null;
}

interface PoolListeners {
  onLoadedMetadata: () => void;
  onCanPlay: () => void;
}

type Listener = () => void;

/** 全 entry を slug→entry で持つ。active/pool 区別は entry.detached で表現。 */
const registry = new Map<string, HandoffEntry>();
const listeners = new Set<Listener>();
/**
 * 直近で claim された slug 群。claim 直後に "promoted" としてログに残すための
 * 一時セット。1 度読み出したら忘れる。
 */
const justClaimed = new Set<string>();

/**
 * プール内 (detached=true) で保持してよい最大要素数 (合計)。
 * これを超えると readiness の低いものから古い順に破棄する。
 * <video> 要素はメモリを使うので 1 桁を維持する。
 *
 * 近い未来 (current/+1/+2/+3) の entry は nearProtected フラグで保護されるため、
 * cap 超過時もそれら以外を優先的に捨てる (trimPoolIfNeeded を参照)。
 */
const MAX_POOLED_ELEMENTS = 6;
/**
 * プール内に保持してよい non-canplay (metadata/loading) entry の最大数。
 * canplay 未到達の隠し要素は復活確率が低めかつ帯域消費が続くので、合計 cap より
 * 厳しめに絞る。これを超えると新しい non-canplay でも古い non-canplay を捨てる。
 * rapid swipe 中は metadata/loading entry が短時間に複数積み上がるため、ある程度
 * 余裕を持って 4 まで許容し、useful な in-progress 要素が早期 evict されないよう
 * する。
 */
const MAX_POOLED_NON_CANPLAY = 4;
/**
 * canplay 済み entry を保持する最大時間 (ms)。
 * rapid swipe 中に slot が頻繁に入れ替わっても、数秒以内に active へ到達すれば
 * canplay 済みバイトが流用できるよう、ある程度長めに設定する。
 */
const POOL_TTL_CANPLAY_MS = 30_000;
/**
 * canplay 未到達 (metadata/loading) entry を保持する最大時間 (ms)。
 * 高速スワイプで slot 構成が頻繁に動くケースでは、隠し要素が canplay へ到達する
 * 前に slot から外れることがある。short TTL の間だけプールに残し、その slug が
 * すぐ active になればそのまま canplay 到達まで subscribe して promote できる。
 */
const POOL_TTL_PENDING_MS = 15_000;
/** cleanup インターバル (ms)。 */
const POOL_CLEANUP_INTERVAL_MS = 2_500;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanupTimer() {
  if (typeof window === "undefined") return;
  if (cleanupTimer != null) return;
  cleanupTimer = setInterval(() => {
    cleanupExpired();
  }, POOL_CLEANUP_INTERVAL_MS);
}

function stopCleanupTimer() {
  if (cleanupTimer != null) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

function cleanupExpired() {
  const now = Date.now();
  let evicted = 0;
  for (const [slug, entry] of registry) {
    if (!entry.detached) continue;
    if (entry.pinned) continue;
    const ttl =
      entry.readiness === "canplay" ? POOL_TTL_CANPLAY_MS : POOL_TTL_PENDING_MS;
    if (now - entry.pooledAt > ttl) {
      disposeEntry(entry);
      evicted += 1;
      vtHandoffLog(
        `pool evict slug=${slug} reason=ttl readiness=${entry.readiness} age=${now - entry.pooledAt}ms`,
      );
    }
  }
  // 実際に eviction (= registry の変化) があったときだけ購読者へ通知する。
  // 以前は毎周期 notify() していたため、registry/listeners が空でも 2.5 秒ごとに
  // 不要な再描画コールバックが走っていた。
  if (evicted > 0) {
    notify();
  }
  // クリーンアップ対象が無くなったらタイマーを止める (idle 時に回し続けない)。
  // 新しい要素が register されたら ensureCleanupTimer() で再始動する。
  if (registry.size === 0) {
    stopCleanupTimer();
  }
}

function notify() {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* ignore listener errors */
    }
  }
}

/**
 * プール retain 中の <video> 要素に readiness リスナを attach する。
 * 多重 attach はガードする。
 */
function attachPoolReadinessListeners(entry: HandoffEntry) {
  if (entry.poolListeners) return;
  const { slug, el } = entry;
  const onLoadedMetadata = () => {
    // entry がプールから外れていたら何もしない (claim 済み / src 切替後など)。
    const cur = registry.get(slug);
    if (!cur || cur.el !== el) return;
    if (cur.readiness === "canplay") return;
    cur.readiness = "metadata";
    vtHandoffLog(`pool readiness slug=${slug} readiness=metadata`);
    notify();
  };
  const onCanPlay = () => {
    const cur = registry.get(slug);
    if (!cur || cur.el !== el) return;
    if (cur.readiness === "canplay") return;
    cur.readiness = "canplay";
    vtHandoffLog(`pool readiness slug=${slug} readiness=canplay`);
    notify();
  };
  el.addEventListener("loadedmetadata", onLoadedMetadata);
  el.addEventListener("canplay", onCanPlay);
  entry.poolListeners = { onLoadedMetadata, onCanPlay };
  // retain 直前に既に readyState が進んでいるケースを拾う (loadedmetadata は
  // PrefetchVideoBuffer 側で観測済みかも知れないので updateReadiness 経路に
  // 揃える)。
  if (el.readyState >= 3 && entry.readiness !== "canplay") {
    entry.readiness = "canplay";
    vtHandoffLog(`pool readiness slug=${slug} readiness=canplay`);
    notify();
  } else if (el.readyState >= 1 && entry.readiness === "metadata") {
    // 何もしない (既に metadata)。
  }
}

function detachPoolReadinessListeners(entry: HandoffEntry) {
  const ls = entry.poolListeners;
  if (!ls) return;
  try {
    entry.el.removeEventListener("loadedmetadata", ls.onLoadedMetadata);
    entry.el.removeEventListener("canplay", ls.onCanPlay);
  } catch {
    /* ignore */
  }
  entry.poolListeners = null;
}

/**
 * registry から entry を完全に取り除くときに使う。
 * pool readiness listener の detach、<video> の destroy、registry.delete を
 * 必ずこの順番で行うので、リスナ漏れによる post-destroy 通知や leak を防ぐ。
 */
function disposeEntry(entry: HandoffEntry) {
  detachPoolReadinessListeners(entry);
  destroyElement(entry.el);
  registry.delete(entry.slug);
}

function vtHandoffLog(message: string) {
  if (!isVideoTimingEnabled()) return;
  // eslint-disable-next-line no-console
  console.debug(`vt handoff ${message}`);
}

/**
 * プール容量超過時、未温まり entry / 古いものから削減する。
 *
 * - pinned entry (= active が pending-handoff として claim 中) は絶対に evict しない。
 * - non-canplay (metadata/loading) は MAX_POOLED_NON_CANPLAY を超えたら古い順に破棄。
 *   ただし nearProtected (current/+1/+2/+3 の未来枠) は後回し。
 * - 合計が MAX_POOLED_ELEMENTS を超えたら、
 *   優先度: 非 nearProtected の metadata → 非 nearProtected の canplay
 *         → nearProtected の metadata → nearProtected の canplay (= 最後まで残す)
 *   の順で古い順に破棄。これにより、rapid swipe で「近い未来 (current+1/+2/+3)
 *   のまだ canplay 未到達 entry」が generic cap eviction で巻き込まれて、
 *   active 到達時に prefetched=false になる事故を減らす。
 */
function trimPoolIfNeeded() {
  // pinned entry は active 側が pending-handoff として claim 中なので絶対に
  // evict しない。cap 計算からも除外する (pin された entry が cap を埋めても、
  // 残りの非 pinned 枠だけで cap を判定する)。
  const detached = Array.from(registry.values()).filter(
    (e) => e.detached && !e.pinned,
  );
  // non-canplay 枠 cap: 非 nearProtected を先に削る。それでも超えていたら
  // nearProtected も古い順に削る (最終 fallback)。
  const nonCanplay = detached.filter((e) => e.readiness !== "canplay");
  if (nonCanplay.length > MAX_POOLED_NON_CANPLAY) {
    const sorted = nonCanplay.slice().sort((a, b) => {
      // 非 nearProtected を優先的に削る (=低 rank 先頭)
      const rankA = a.nearProtected ? 1 : 0;
      const rankB = b.nearProtected ? 1 : 0;
      if (rankA !== rankB) return rankA - rankB;
      return a.pooledAt - b.pooledAt;
    });
    const overflow = sorted.slice(0, sorted.length - MAX_POOLED_NON_CANPLAY);
    for (const entry of overflow) {
      disposeEntry(entry);
      vtHandoffLog(
        `pool evict slug=${entry.slug} reason=cap-pending readiness=${entry.readiness} near=${entry.nearProtected}`,
      );
    }
  }
  const remaining = Array.from(registry.values()).filter(
    (e) => e.detached && !e.pinned,
  );
  if (remaining.length <= MAX_POOLED_ELEMENTS) {
    // 全 detached が pinned で cap オーバーしているケースだけログ。
    const totalDetached = Array.from(registry.values()).filter((e) => e.detached);
    if (totalDetached.length > MAX_POOLED_ELEMENTS) {
      vtHandoffLog(
        `pool evict skip pinned detached=${totalDetached.length} cap=${MAX_POOLED_ELEMENTS}`,
      );
    }
    return;
  }
  // 削除優先度 (低 → 高):
  //   0: 非 nearProtected かつ metadata
  //   1: 非 nearProtected かつ canplay
  //   2: nearProtected かつ metadata
  //   3: nearProtected かつ canplay (= 最後まで残す)
  // 同 rank 内では古い順に削る。
  remaining.sort((a, b) => {
    const rankA =
      (a.nearProtected ? 2 : 0) + (a.readiness === "canplay" ? 1 : 0);
    const rankB =
      (b.nearProtected ? 2 : 0) + (b.readiness === "canplay" ? 1 : 0);
    if (rankA !== rankB) return rankA - rankB;
    return a.pooledAt - b.pooledAt;
  });
  const toRemove = remaining.slice(0, remaining.length - MAX_POOLED_ELEMENTS);
  for (const entry of toRemove) {
    disposeEntry(entry);
    vtHandoffLog(
      `pool evict slug=${entry.slug} reason=cap readiness=${entry.readiness} near=${entry.nearProtected}`,
    );
  }
}

/**
 * prefetch buffer 側から呼ぶ。新規 <video> 要素を作って host に append し、
 * registry へ登録する。同 slug の既存 entry がある場合は src が一致して連結中で
 * あれば再利用、それ以外は古い要素を destroy。
 *
 * `tailKeepSec` (秒) を渡すと、隠し <video> の loadedmetadata 後に
 * currentTime を `duration - tailKeepSec` (= 末尾 tailKeepSec だけ残す開始位置)
 * にセットする。これによりブラウザは「先頭のバッファ」だけでなく
 * 「開始位置付近のバッファ」も Range request で取得しに行く。
 *
 * 背景: pro-actress 作品は active 側で必ず末尾 (duration-90) にシークするが、
 * 隠し <video> がデフォルトで先頭バイトだけしか preload しないと、active が
 * promote した直後の seek で開始位置のバイトが未取得 → loadedmetadata 後の
 * rebuffer 待ちが発生し、playback start まで 1〜数秒遅延する
 * (`pro-actress seek deadline extend reason=loading-at-minStart` のループ)。
 * 開始位置を事前に currentTime に書き込むことで、ブラウザが裏で開始位置付近の
 * Range も投げてくれるので、active 化時の seek が即 canplay まで進む。
 *
 * duration 依存のため、実際の seek 秒数は隠し要素の loadedmetadata 後に
 * `tailStartForDuration(duration, tailKeepSec)` で算出する。
 */
export function registerPrefetchElement(args: {
  slug: string;
  src: string;
  preload: "auto" | "metadata" | "none";
  /**
   * 末尾に残す秒数 (= pro-actress は 90)。0 / undefined はノーマルケース。
   * loadedmetadata 後に `duration - tailKeepSec` を currentTime にセットする。
   */
  tailKeepSec?: number;
}): HTMLVideoElement {
  ensureCleanupTimer();
  const { slug, src, preload, tailKeepSec = 0 } = args;
  const existing = registry.get(slug);
  if (existing) {
    // 同 src ならば、検出された preload / 接続状態に関係なく要素を再利用して
    // readiness とバッファをそのまま温存する。プールから戻ってきたケースも含む。
    if (existing.src === src) {
      const fromPool = existing.detached;
      const previousPreload = existing.el.preload;
      if (previousPreload !== preload) {
        existing.el.preload = preload;
        // metadata で作った軽量ウォーム slot が +2/+1 に近づいて auto へ昇格した時、
        // preload 属性を変えるだけではブラウザが追加 Range request を始めないことがある。
        // 既に canplay していない、かつ現在ロード中でもない場合だけ load() を蹴り、
        // 既存 src / cache を使って先頭バッファ取得を確実に開始させる。
        const shouldKickAutoLoad =
          preload === "auto" &&
          previousPreload !== "auto" &&
          existing.el.readyState < 3 &&
          existing.el.networkState !== 2;
        if (shouldKickAutoLoad) {
          try {
            existing.el.load();
            vtHandoffLog(
              `reload slug=${slug} reason=preload-upgrade from=${previousPreload} to=${preload}`,
            );
          } catch {
            /* ignore */
          }
        }
      }
      // PrefetchVideoBuffer が新たに自前の readiness リスナを貼るので、
      // pool 専用リスナは外して二重発火を避ける。
      detachPoolReadinessListeners(existing);
      existing.detached = false;
      existing.pooledAt = Date.now();
      // 再利用される要素にもまだ開始位置のバッファが入っていない可能性が
      // あるので、currentTime が 0 のままなら遅延セットを再アーム。既に開始位置
      // 以上に進んでいる (= 既に seek 済み or 再生中) なら何もしない。
      ensureTailStartArmed(existing.el, slug, tailKeepSec);
      vtHandoffLog(
        `reuse slug=${slug} preload=${preload} readiness=${existing.readiness} from=${fromPool ? "pool" : "active"}${tailKeepSec > 0 ? ` tailKeep=${tailKeepSec}` : ""}`,
      );
      return existing.el;
    }
    // src が変わった (force-resolve リトライなど) → 古いノードを破棄
    disposeEntry(existing);
  }
  const el = document.createElement("video");
  el.src = src;
  el.preload = preload;
  el.muted = true;
  el.playsInline = true;
  el.setAttribute("aria-hidden", "true");
  el.tabIndex = -1;
  // ORB 対策: 画面外配置 + 通常サイズ
  el.style.position = "fixed";
  el.style.top = "-9999px";
  el.style.left = "-9999px";
  el.style.width = "100px";
  el.style.height = "100px";
  el.style.opacity = "0";
  el.style.pointerEvents = "none";
  el.style.zIndex = "-1";
  // tailKeepSec があれば loadedmetadata で currentTime を開始位置 (duration-tail)
  // にセットして開始位置付近のバイト取得を browser に依頼する。`<video>.load()`
  // の前にハンドラを仕込む (preload="none" の場合は loadedmetadata が来ないので
  // 何も起きないが、通常の preload="auto"/"metadata" では確実にハンドラが走る)。
  ensureTailStartArmed(el, slug, tailKeepSec);
  // iOS Safari は load() を呼ばないと preload が走らないことがある
  try {
    el.load();
  } catch {
    /* ignore */
  }
  registry.set(slug, {
    slug,
    src,
    el,
    readiness: "metadata",
    pooledAt: Date.now(),
    detached: false,
    pinned: false,
    nearProtected: false,
    poolListeners: null,
  });
  vtHandoffLog(
    `register slug=${slug} preload=${preload}${tailKeepSec > 0 ? ` tailKeep=${tailKeepSec}` : ""}`,
  );
  notify();
  return el;
}

/**
 * 隠し <video> 要素に「loadedmetadata 後に currentTime=開始位置 (duration-tail)
 * をセットする」one-shot ハンドラを仕込む。
 *
 * 旧 `ensureMinStartArmed` は固定値 (5) を渡していたが、pro-actress の仕様が
 * 「末尾 90 秒だけ残す」= duration 依存になったため、開始位置は duration が
 * 分かるまで計算できない。よって seek 秒数を loadedmetadata の中で
 * `tailStartForDuration(el.duration, tailKeepSec)` により算出する。
 *
 * - tailKeepSec<=0: 何もしない。
 * - 既に loadedmetadata 済み (readyState>=1): duration から開始位置を計算して即セット。
 * - readyState<1: 1 度だけ loadedmetadata を待って計算 + セット。
 *
 * `currentTime` 設定後は seek が走るので、browser が Range request で seek
 * 先付近のバイトを取りに行く。これは隠し要素の readiness ステート遷移
 * (loadedmetadata → seeking → seeked → canplay) を経るので、prefetch の
 * canplay 判定も seek 完了後に出るようになる (= active 化時の seek が即時化)。
 *
 * 再アーム時 (=同 src 再利用): 既存ハンドラを撤去してから再登録。これにより
 * 同じ要素に重複ハンドラが残らない。
 */
function ensureTailStartArmed(
  el: HTMLVideoElement,
  slug: string,
  tailKeepSec: number,
) {
  if (!Number.isFinite(tailKeepSec) || tailKeepSec <= 0) return;
  const applySeek = () => {
    const start = tailStartForDuration(el.duration, tailKeepSec);
    // 開始位置が 0 (= duration 未確定 or 動画が tail より短い) なら seek 不要。
    if (start <= 0) return;
    // 既に開始位置以上に進んでいるなら何もしない (= 既に seek 済み or 再生中)。
    if (el.currentTime + 0.05 >= start) return;
    try {
      el.currentTime = start;
      vtHandoffLog(`tail-start-seek slug=${slug} t=${start.toFixed(2)} tailKeep=${tailKeepSec}`);
    } catch {
      /* ignore (まれに NotSupportedError) */
    }
  };
  if (el.readyState >= 1) {
    // 既に metadata 取得済みなら duration が読めるので即計算 + セット。
    applySeek();
    return;
  }
  // 旧ハンドラがあれば消して、再アーム。
  const prev = (el as HTMLVideoElement & { __tailStartHandler__?: () => void })
    .__tailStartHandler__;
  if (prev) {
    el.removeEventListener("loadedmetadata", prev);
  }
  const handler = () => {
    applySeek();
    el.removeEventListener("loadedmetadata", handler);
    (el as HTMLVideoElement & { __tailStartHandler__?: () => void })
      .__tailStartHandler__ = undefined;
  };
  (el as HTMLVideoElement & { __tailStartHandler__?: () => void })
    .__tailStartHandler__ = handler;
  el.addEventListener("loadedmetadata", handler);
}

export function updateReadiness(slug: string, readiness: HandoffReadiness) {
  const entry = registry.get(slug);
  if (!entry) return;
  if (entry.readiness === "canplay" && readiness === "metadata") {
    // canplay > metadata の格下げはしない
    return;
  }
  if (entry.readiness === readiness) return;
  entry.readiness = readiness;
  notify();
}

export function getReadiness(slug: string): HandoffReadiness | null {
  const entry = registry.get(slug);
  return entry ? entry.readiness : null;
}

/**
 * 隠し prefetch entry の現状を診断するヘルパ。
 * active 側が「自分の videoSrc に対して promote 可能か」を 1 度のレジストリ
 * 参照で判定し、UI 用の readiness 表示に「stale (entry あるが src 不一致)」
 * のような状態も乗せられるようにする。
 *
 * - present=false:        registry に entry が無い (= 未登録 / 既に claim 済み / evicted)。
 * - present=true, srcMatches=true: 正規ヒット。readiness は entry.readiness。
 * - present=true, srcMatches=false: slug は一致するが src が違う (force re-resolve 後など)。
 *                                    promote 不能。readiness は参考値。
 */
export function inspectEntry(slug: string, src: string | null): {
  present: boolean;
  srcMatches: boolean;
  readiness: HandoffReadiness | null;
} {
  const entry = registry.get(slug);
  if (!entry) return { present: false, srcMatches: false, readiness: null };
  return {
    present: true,
    srcMatches: src != null && entry.src === src,
    readiness: entry.readiness,
  };
}

export function hasPromotableElement(slug: string, src: string): boolean {
  const entry = registry.get(slug);
  if (!entry) return false;
  if (entry.src !== src) return false;
  return entry.readiness === "canplay";
}

/**
 * 「同 slug の隠し要素が登録済みだが canplay 未到達」なペンディング状態か。
 * active 側がこの状態を検出したら、即 promote せずに subscribe で canplay 到達を
 * 待つ。slug 不一致 / src 不一致 / 未登録は false。
 */
export function hasPendingElement(slug: string, src: string): boolean {
  const entry = registry.get(slug);
  if (!entry) return false;
  if (entry.src !== src) return false;
  return entry.readiness !== "canplay";
}

/**
 * feed 側から呼ぶ。
 * 該当エントリを registry から取り外し、所有権を呼出側に移す。
 * 戻り値の element は呼出側が host にて appendChild する。
 *
 * promotion 不能な場合 (slug 不一致 / canplay 未到達 / src 不一致) は null。
 * miss 時の理由は vt ログに出る。
 */
export function claimForFeed(slug: string, src: string): HTMLVideoElement | null {
  const entry = registry.get(slug);
  if (!entry) {
    vtHandoffLog(`claim miss slug=${slug} reason=not-found`);
    return null;
  }
  if (entry.src !== src) {
    vtHandoffLog(
      `claim miss slug=${slug} reason=src-mismatch expected=${truncate(src)} have=${truncate(entry.src)}`,
    );
    return null;
  }
  if (entry.readiness !== "canplay") {
    vtHandoffLog(`claim miss slug=${slug} reason=not-canplay readiness=${entry.readiness}`);
    return null;
  }
  // pool retain 中にリスナを貼っていたら、claim 直前に外す。active 側 (FeedItem)
  // は claim した要素に自前の loadedmetadata/canplay/playing リスナを貼るため、
  // 二重 dispatch を避ける。
  detachPoolReadinessListeners(entry);
  registry.delete(slug);
  justClaimed.add(slug);
  vtHandoffLog(
    `claim hit slug=${slug} readiness=${entry.readiness} from=${entry.detached ? "pool" : "active"}`,
  );
  notify();
  return entry.el;
}

function truncate(s: string): string {
  if (!s) return "";
  return s.length > 40 ? `${s.slice(0, 24)}…${s.slice(-12)}` : s;
}

/**
 * prefetch buffer がアンマウントするときに呼ぶ。
 *
 * - claim 済み (registry から既に消えている) → no-op。
 * - readiness=canplay の場合 → プールに retain (detach) し、長め TTL/cap で後段破棄。
 * - readiness=metadata / loading → プールに retain。短命 TTL + 専用 cap でキープし、
 *   後から active に到達した slug が canplay 到達を待って promote できるよう残す。
 *
 * このフックにより、+1/+2 の slot 構成が rapid swipe で頻繁に変わっても、
 * 隠し <video> はすぐ消されず、in-progress なバイト取得を活かして active へ
 * pending-handoff できる。
 */
export function releasePrefetchElement(slug: string, el: HTMLVideoElement | null) {
  if (!el) return;
  const entry = registry.get(slug);
  if (!entry || entry.el !== el) {
    // registry にいない = 既に feed に claim されている。何もしない。
    return;
  }
  // プールに retain。元の host から外し、document.body にぶら下げる。
  // (host <div> がアンマウント途中で消えるため、ブラウザに保持してもらうために
  // 画面外 <body> 直下に置く。画面外座標と opacity=0 のまま帯域も殆ど食わない。)
  if (entry.el.parentNode) {
    entry.el.parentNode.removeChild(entry.el);
  }
  try {
    document.body.appendChild(entry.el);
  } catch {
    /* ignore (body 未準備など) */
  }
  entry.detached = true;
  entry.pooledAt = Date.now();
  // PrefetchVideoBuffer 側の readiness リスナは cleanup で外れているため、
  // プールが responsible 主体として loadedmetadata / canplay を subscribe する。
  // これがないと metadata で retain された要素はその後 canplay に達しても
  // registry の readiness が metadata で固まり、active 到達時の tryClaim が
  // `not-canplay → host-only-deadlock → force-fallback` に落ちる。
  attachPoolReadinessListeners(entry);
  vtHandoffLog(`pool retain slug=${slug} readiness=${entry.readiness}`);
  trimPoolIfNeeded();
  notify();
}

/**
 * active 側が pending-handoff の claim 中であることを registry に伝える。
 * pin されている間は cap / TTL クリーンアップで evict されない。
 * canplay 到達による promote、または abandon を起こした active 側が
 * `unpinSlug` で必ず解除する。
 *
 * 戻り値: pin に成功したか (= 該当 slug / src の entry が registry に存在するか)。
 */
export function pinSlug(slug: string, src: string): boolean {
  const entry = registry.get(slug);
  if (!entry) return false;
  if (entry.src !== src) return false;
  if (entry.pinned) return true;
  entry.pinned = true;
  vtHandoffLog(`pool pin slug=${slug} readiness=${entry.readiness}`);
  return true;
}

/**
 * pinSlug で立てたピンを下ろす。entry が既に消えていれば no-op。
 */
export function unpinSlug(slug: string) {
  const entry = registry.get(slug);
  if (!entry) return;
  if (!entry.pinned) return;
  entry.pinned = false;
  vtHandoffLog(`pool unpin slug=${slug} readiness=${entry.readiness}`);
}

/**
 * 近距離未来枠 (current/+1/+2/+3) の slug をまとめて nearProtected に同期する。
 *
 * pin より弱い保護: cap 超過時の eviction で nearProtected を後回しにする。
 * TTL eviction は通常通り (canplay=長 / pending=短) 効くので、長時間放置された
 * 隠し要素は最終的に破棄される。
 *
 * 呼出側 (usePrefetchVideoBytes) は currentIndex 周辺の slug 集合を毎レンダー
 * 通知し、本関数が registry の現状と diff を取って set/unset を行う。
 *
 * - 集合に含まれない slug の nearProtected は false に戻す。
 * - 集合に含まれる slug の entry が registry にあれば true。entry が無いなら no-op
 *   (この slug は登録前 or 既に claim 済み)。
 */
export function syncNearProtection(slugs: ReadonlyArray<string>): void {
  const wanted = new Set(slugs);
  for (const [slug, entry] of registry) {
    const shouldProtect = wanted.has(slug);
    if (entry.nearProtected === shouldProtect) continue;
    entry.nearProtected = shouldProtect;
    if (shouldProtect) {
      vtHandoffLog(`pool near-protect slug=${slug} readiness=${entry.readiness}`);
    } else {
      vtHandoffLog(`pool near-release slug=${slug} readiness=${entry.readiness}`);
    }
  }
}

/**
 * 同 slug の最新 src と異なる src に切り替えたい (force re-resolve など) ときに
 * 強制破棄するためのヘルパ。
 */
export function evictSlug(slug: string) {
  const entry = registry.get(slug);
  if (!entry) return;
  disposeEntry(entry);
  notify();
}

function destroyElement(el: HTMLVideoElement) {
  try {
    el.pause();
  } catch {
    /* ignore */
  }
  try {
    el.removeAttribute("src");
    el.load();
  } catch {
    /* ignore */
  }
  if (el.parentNode) {
    el.parentNode.removeChild(el);
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function consumeJustClaimed(slug: string): boolean {
  if (!justClaimed.has(slug)) return false;
  justClaimed.delete(slug);
  return true;
}

/**
 * Active 側 (FeedItem) が「現在 active になった slug を claim しようとしたが
 * registry エントリが promote 不能だった」ことを記録するための短命シグナル。
 *
 * 用途:
 *   - usePrefetchVideoBytes の active-transition ログは、隠し <video> 側で観測した
 *     readiness (loadedmetadata / canplay) を slug 単位の ref に永続的に保持して
 *     いる。一方で registry 側 entry は TTL / cap eviction / claim / src 切替で
 *     消えうるため、`readinessRef は canplay` だが「実際の claim は no-entry /
 *     src-mismatch / not-canplay で失敗」というケースが発生する。
 *   - FeedItem.tryClaim が claim 失敗を検出したタイミングで本関数を呼ぶと、
 *     直後に走る `byte-prefetch active` / `readiness window` ログがその stale
 *     状態を検知して `false` に downgrade できる。これにより
 *     `byte-prefetched=canplay` と表示しながら裏では JSX <video> をゼロから
 *     立ち上げ直す、観測と実体が乖離した状態を解消する。
 *
 * セマンティクス:
 *   - 1 回 set → 1 回 consume の短命フラグ。consume すると消える。
 *   - 同 slug に対する複数 reason は最後勝ち。
 *   - active ログが走るより前の 1 tick で set される想定 (FeedItem の
 *     useLayoutEffect が usePrefetchVideoBytes の passive useEffect より前に
 *     走るので順序は保証される)。
 */
type StaleClaimReason = "no-entry" | "src-mismatch" | "not-canplay";
const staleClaims = new Map<string, StaleClaimReason>();

export function markStaleClaim(slug: string, reason: StaleClaimReason): void {
  staleClaims.set(slug, reason);
  // claim 不能と判明したのに registry に残骸 entry がいると、
  //   - 直後の releasePrefetchElement (PrefetchVideoBuffer のアンマウント) で
  //     pool retain され、TTL いっぱい canplay 表示を偽陽性で出し続ける。
  //   - 後続の active-transition log も `byte-prefetched=canplay` のまま
  //     getReadiness で見えてしまう。
  // active 側は既に JSX <video> でゼロ再生に入る orientation なので、
  // ここでまとめて破棄して以降のシグナルから外す。pinned (= 別 active が
  // pending-handoff 中) のときだけは保護する (= 別 slug の claim 中の可能性は
  // ほぼないが、安全側に倒す)。
  const entry = registry.get(slug);
  if (entry && !entry.pinned) {
    disposeEntry(entry);
    vtHandoffLog(
      `pool evict slug=${slug} reason=stale-claim claim-reason=${reason}`,
    );
    notify();
  }
}

export function consumeStaleClaim(slug: string): StaleClaimReason | null {
  const r = staleClaims.get(slug);
  if (r === undefined) return null;
  staleClaims.delete(slug);
  return r;
}

export function peekStaleClaim(slug: string): StaleClaimReason | null {
  return staleClaims.get(slug) ?? null;
}
