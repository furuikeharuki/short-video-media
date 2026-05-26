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

function cleanupExpired() {
  const now = Date.now();
  for (const [slug, entry] of registry) {
    if (!entry.detached) continue;
    if (entry.pinned) continue;
    const ttl =
      entry.readiness === "canplay" ? POOL_TTL_CANPLAY_MS : POOL_TTL_PENDING_MS;
    if (now - entry.pooledAt > ttl) {
      destroyElement(entry.el);
      registry.delete(slug);
      vtHandoffLog(
        `pool evict slug=${slug} reason=ttl readiness=${entry.readiness} age=${now - entry.pooledAt}ms`,
      );
    }
  }
  notify();
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

function vtHandoffLog(message: string) {
  if (!isVideoTimingEnabled()) return;
  // eslint-disable-next-line no-console
  console.debug(`vt handoff ${message}`);
}

/**
 * プール容量超過時、未温まり entry / 古いものから削減する。
 *
 * - non-canplay (metadata/loading) は MAX_POOLED_NON_CANPLAY を超えたら古い順に破棄。
 * - 合計が MAX_POOLED_ELEMENTS を超えたら、readiness=metadata 優先 → 古い順に破棄
 *   (canplay 済みは最後まで残す)。
 */
function trimPoolIfNeeded() {
  // pinned entry は active 側が pending-handoff として claim 中なので絶対に
  // evict しない。cap 計算からも除外する (pin された entry が cap を埋めても、
  // 残りの非 pinned 枠だけで cap を判定する)。
  const detached = Array.from(registry.values()).filter(
    (e) => e.detached && !e.pinned,
  );
  const nonCanplay = detached
    .filter((e) => e.readiness !== "canplay")
    .sort((a, b) => a.pooledAt - b.pooledAt);
  if (nonCanplay.length > MAX_POOLED_NON_CANPLAY) {
    const overflow = nonCanplay.slice(0, nonCanplay.length - MAX_POOLED_NON_CANPLAY);
    for (const entry of overflow) {
      destroyElement(entry.el);
      registry.delete(entry.slug);
      vtHandoffLog(
        `pool evict slug=${entry.slug} reason=cap-pending readiness=${entry.readiness}`,
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
  // 削除優先度: readiness=metadata を先に / その中で古いものから。
  remaining.sort((a, b) => {
    const rankA = a.readiness === "canplay" ? 1 : 0;
    const rankB = b.readiness === "canplay" ? 1 : 0;
    if (rankA !== rankB) return rankA - rankB; // metadata(0) を先頭へ
    return a.pooledAt - b.pooledAt; // 古い順
  });
  const toRemove = remaining.slice(0, remaining.length - MAX_POOLED_ELEMENTS);
  for (const entry of toRemove) {
    destroyElement(entry.el);
    registry.delete(entry.slug);
    vtHandoffLog(`pool evict slug=${entry.slug} reason=cap readiness=${entry.readiness}`);
  }
}

/**
 * prefetch buffer 側から呼ぶ。新規 <video> 要素を作って host に append し、
 * registry へ登録する。同 slug の既存 entry がある場合は src が一致して連結中で
 * あれば再利用、それ以外は古い要素を destroy。
 */
export function registerPrefetchElement(args: {
  slug: string;
  src: string;
  preload: "auto" | "metadata" | "none";
}): HTMLVideoElement {
  ensureCleanupTimer();
  const { slug, src, preload } = args;
  const existing = registry.get(slug);
  if (existing) {
    // 同 src ならば、検出された preload / 接続状態に関係なく要素を再利用して
    // readiness とバッファをそのまま温存する。プールから戻ってきたケースも含む。
    if (existing.src === src) {
      const fromPool = existing.detached;
      if (existing.el.preload !== preload) {
        existing.el.preload = preload;
      }
      existing.detached = false;
      existing.pooledAt = Date.now();
      vtHandoffLog(
        `reuse slug=${slug} preload=${preload} readiness=${existing.readiness} from=${fromPool ? "pool" : "active"}`,
      );
      return existing.el;
    }
    // src が変わった (force-resolve リトライなど) → 古いノードを破棄
    destroyElement(existing.el);
    registry.delete(slug);
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
  });
  vtHandoffLog(`register slug=${slug} preload=${preload}`);
  notify();
  return el;
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
 * 同 slug の最新 src と異なる src に切り替えたい (force re-resolve など) ときに
 * 強制破棄するためのヘルパ。
 */
export function evictSlug(slug: string) {
  const entry = registry.get(slug);
  if (!entry) return;
  destroyElement(entry.el);
  registry.delete(slug);
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
