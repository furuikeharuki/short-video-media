/**
 * 隠し prefetch <video> 要素を active 表示にそのまま流用する (要素 handoff) ための
 * 軽量レジストリ。
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
 *   - 両側 (prefetch / feed) は host <div ref> に対して imperative に
 *     appendChild する。レジストリが element の所有権を仲介する。
 *   - readiness は "metadata" / "canplay" の 2 段階で公開し、feed 側は canplay
 *     にだけ promote する (旧 low/high dual-video swap は復活させない)。
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
}

type Listener = () => void;

const registry = new Map<string, HandoffEntry>();
const listeners = new Set<Listener>();
/**
 * 直近で claim された slug 群。claim 直後に "promoted" としてログに残すための
 * 一時セット。1 度読み出したら忘れる。
 */
const justClaimed = new Set<string>();

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
 * prefetch buffer 側から呼ぶ。新規 <video> 要素を作って host に append し、
 * registry へ登録する。同 slug の既存 entry がある場合は古い要素を destroy。
 */
export function registerPrefetchElement(args: {
  slug: string;
  src: string;
  preload: "auto" | "metadata" | "none";
}): HTMLVideoElement {
  const { slug, src, preload } = args;
  const existing = registry.get(slug);
  if (existing) {
    if (existing.src === src && existing.el.isConnected) {
      // 同 slug / 同 src で既に登録済みならそのまま再利用
      return existing.el;
    }
    // src 変更 (force-resolve リトライなど) → 古いノードを破棄
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
  registry.set(slug, { slug, src, el, readiness: "metadata" });
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
 * feed 側から呼ぶ。
 * 該当エントリを registry から取り外し、所有権を呼出側に移す。
 * 戻り値の element は呼出側が host にて appendChild する。
 *
 * promotion 不能な場合 (slug 不一致 / canplay 未到達 / src 不一致) は null。
 */
export function claimForFeed(slug: string, src: string): HTMLVideoElement | null {
  const entry = registry.get(slug);
  if (!entry) return null;
  if (entry.src !== src) return null;
  if (entry.readiness !== "canplay") return null;
  registry.delete(slug);
  justClaimed.add(slug);
  vtHandoffLog(`claim slug=${slug} readiness=${entry.readiness}`);
  notify();
  return entry.el;
}

/**
 * prefetch buffer がアンマウントするときに呼ぶ。claim 済みでなければ要素を破棄。
 * claim 済みなら no-op (要素は feed が所有している)。
 */
export function releasePrefetchElement(slug: string, el: HTMLVideoElement | null) {
  if (!el) return;
  const entry = registry.get(slug);
  if (entry && entry.el === el) {
    destroyElement(el);
    registry.delete(slug);
    vtHandoffLog(`release slug=${slug}`);
    notify();
    return;
  }
  // registry にいない = 既に feed に claim されている。何もしない。
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
