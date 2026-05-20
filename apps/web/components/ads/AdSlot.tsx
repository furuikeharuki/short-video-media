"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AD_ZONES, isAdZoneEnabled, type AdZoneKey } from "@/lib/ads/config";
import { resetAndServeAd, serveAd } from "./AdScriptLoader";

type Props = {
  zone: AdZoneKey;
  className?: string;
  style?: React.CSSProperties;
  label?: string | null;
  context?: string;
  resetOnMount?: boolean;
  /**
   * モーダル等「同じ zoneid の他の <ins> が背後の DOM に残ったまま開かれる場面」用フラグ。
   *
   * priority=true のとき:
   *   1. IntersectionObserver の交差判定を待たずに mount 直後 (rAF 後) に serve を発火する。
   *      モーダル末尾の <ins> は初期描画時にスクロール下にあり、creative ロード前は
   *      height=0 なため、IO が isIntersecting=true を発火しないことがある。
   *   2. serve push の前に、この AdSlot の <ins> 以外で同じ zoneid を持つ <ins>
   *      (例: フィードの FeedAdSlide) の data-zoneid を一時的に空に退避する。
   *      provider はそのあいだ「埋まっていない同 zoneid の <ins>」がモーダル側
   *      しかないように見えるため、フィード <ins> に serve を取られない。
   *   3. 0ms / 1.0s / 2.5s の 3 段階で serve を再試行する (各回ごとに mask + restore)。
   *      provider の DOM スキャンが遅延・空振りしても確実にモーダル枠を埋める。
   *   4. sessionStorage に基づく "前回埋まっていたから minHeight 確保" の事前表示は
   *      行わない (前のモーダル open で書かれた値で「広告」ラベルだけ先に出る問題を回避)。
   */
  priority?: boolean;
};

function makeStorageKey(zone: AdZoneKey, context: string) {
  return `ad_slot_filled_${zone}_${context}`;
}

/**
 * `?adDebug=1` を URL に付ける or `localStorage.adDebug="1"` を設定すると
 * priority モード AdSlot の serve タイミングを console に出す。
 * 何も付けないときは完全に no-op (本番には何も出力されない)。
 *
 * モーダル広告が表示されない症状の調査で「ins が DOM にあるか / serve push が
 * 走ったか / 競合 ins を mask したか」を後から見るために最小限のログだけ残す。
 *
 * モーダルを開くと URL が変わって `?adDebug=1` が消えてしまうため、一度でも
 * `?adDebug=1` を見たら localStorage に焼いて以降ずっと有効にする。`?adDebug=0`
 * で明示的に解除できる。
 */
function isAdDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("adDebug");
    if (fromQuery === "1") {
      window.localStorage?.setItem("adDebug", "1");
      return true;
    }
    if (fromQuery === "0") {
      window.localStorage?.removeItem("adDebug");
      return false;
    }
    return window.localStorage?.getItem("adDebug") === "1";
  } catch {
    return false;
  }
}

function adDebugLog(...args: unknown[]): void {
  if (!isAdDebugEnabled()) return;
  // eslint-disable-next-line no-console
  console.log("[AdSlot]", ...args);
}

/**
 * 現在 DOM に存在する `<ins data-zoneid="${zoneId}">` (および stash 中の
 * `<ins data-ad-zone-stash="${zoneId}">`) の状態を全部ダンプする。
 *
 * `?adDebug=1` のときだけ走る。広告 iframe が「provider 的には成功なのに
 * ユーザに見えていない」現象 (= iframe が detached ノードや別 `<ins>` に
 * 入ってしまっている等) の調査用。各要素の DOM 接続状態 / 親チェーン /
 * 内側の iframe / 描画矩形を吐き出す。
 */
function dumpInsForZone(zoneId: string, label: string, insClass?: string): void {
  if (!isAdDebugEnabled() || typeof document === "undefined") return;
  const live = Array.from(
    document.querySelectorAll<HTMLElement>(`ins[data-zoneid="${zoneId}"]`),
  );
  const stashed = Array.from(
    document.querySelectorAll<HTMLElement>(
      `ins[data-ad-zone-stash="${zoneId}"]`,
    ),
  );
  const byClass = insClass
    ? Array.from(document.querySelectorAll<HTMLElement>(`ins.${insClass}`))
    : [];
  const seen = new Set<HTMLElement>();
  const all: HTMLElement[] = [];
  for (const el of [...live, ...stashed, ...byClass]) {
    if (!seen.has(el)) {
      seen.add(el);
      all.push(el);
    }
  }
  const dump = all.map((el) => {
    const rect = el.getBoundingClientRect();
    const parents: string[] = [];
    let cur: HTMLElement | null = el.parentElement;
    let depth = 0;
    while (cur && depth < 8) {
      parents.push(
        `${cur.tagName}${cur.id ? "#" + cur.id : ""}${cur.className && typeof cur.className === "string" ? "." + cur.className.split(" ").filter(Boolean).join(".") : ""}`,
      );
      cur = cur.parentElement;
      depth++;
    }
    return {
      adInsId: el.dataset.adInsId ?? null,
      connected: el.isConnected,
      dataZoneId: el.getAttribute("data-zoneid"),
      stashZone: el.dataset.adZoneStash ?? null,
      stashClass: el.dataset.adClassStash ?? null,
      cls: el.className,
      hasIframe: !!el.querySelector("iframe"),
      iframeSrc: el.querySelector("iframe")?.getAttribute("src") ?? null,
      childCount: el.children.length,
      innerHTMLLength: el.innerHTML.length,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      parents,
    };
  });
  // 「provider が iframe を <ins> の外 (= body / 別の DOM サブツリー) に
  //  挿入してしまっている」ケースの検知用に、ページ全体の iframe を
  //  ざっとスキャンして magsrv / exoclick 系を抽出する。
  const adIframes = Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe"))
    .filter((f) => {
      const src = f.getAttribute("src") ?? "";
      return (
        src.includes("magsrv.com") ||
        src.includes("exoclick") ||
        src.includes("exosrv") ||
        src.includes("pemsrv") ||
        src.includes("ad-") ||
        src.includes("banner")
      );
    })
    .map((f) => {
      const rect = f.getBoundingClientRect();
      const parentTag = f.parentElement
        ? `${f.parentElement.tagName}${
            f.parentElement.id ? "#" + f.parentElement.id : ""
          }`
        : null;
      return {
        src: f.getAttribute("src"),
        parentTag,
        parentIsIns: f.parentElement?.tagName === "INS",
        parentInsAdId: f.parentElement?.dataset?.adInsId ?? null,
        parentInsZone: f.parentElement?.getAttribute("data-zoneid") ?? null,
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        connected: f.isConnected,
      };
    });
  // eslint-disable-next-line no-console
  console.log(
    `[AdSlot:dump:${label}] zone=${zoneId} count=${all.length} adIframes=${adIframes.length}`,
    { ins: dump, adIframes },
  );
}

function readWasFilled(zone: AdZoneKey, context: string): boolean {
  try {
    return sessionStorage.getItem(makeStorageKey(zone, context)) === "1";
  } catch {
    return false;
  }
}

function writeWasFilled(zone: AdZoneKey, context: string): void {
  try {
    sessionStorage.setItem(makeStorageKey(zone, context), "1");
  } catch { /* ignore */ }
}

/**
 * `selfIns` 以外で、provider のスキャナから「同じターゲット <ins>」と見える可能性のある
 * 要素をすべて一時的に provider から見えなくする。
 *
 * 退避対象の属性:
 *   - data-zoneid  (ExoClick provider が zone を識別するのに使う想定)
 *   - class        (ExoClick の renderer が `ins.eas6a97888eXX` で querySelector して
 *                   iframe を挿入するバリエーションがあるため、class を空にして
 *                   セレクタにヒットしないようにする)
 *   - width / height (renderer 側で寸法を読むときの誤マッチ対策)
 *
 * これらを `data-ad-zone-stash` (= 元の data-zoneid) と `data-ad-class-stash` /
 * `data-ad-width-stash` / `data-ad-height-stash` に逃がし、復元用クロージャを返す。
 *
 * data-zoneid 単独 mask だと「provider が class セレクタで <ins> を選ぶ」場合に
 * 競合 <ins> も serve 対象となり、push 1 回で消費する 1 ad request が背後の
 * フィード <ins> に取られて、モーダル <ins> が空のまま残る不具合が観測された
 * (modal を 2 回目以降開いたとき再現)。class まで mask することでセレクタが
 * どちらでもモーダル側だけが残るようになる。
 *
 * 復元は冪等で、すでに stash 済みの要素は二重 stash しない (本来値の保護)。
 */
function maskCompetingInsElements(
  zoneId: string,
  insClass: string,
  selfIns: HTMLElement | null,
): () => void {
  if (typeof document === "undefined" || !zoneId) return () => {};
  // data-zoneid と class セレクタの両方で候補を集める (どちらかが空でも拾えるように)。
  const byZone = Array.from(
    document.querySelectorAll<HTMLElement>(`ins[data-zoneid="${zoneId}"]`),
  );
  const byClass = insClass
    ? Array.from(
        document.querySelectorAll<HTMLElement>(`ins.${insClass}`),
      )
    : [];
  const all: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const el of [...byZone, ...byClass]) {
    if (!seen.has(el)) {
      seen.add(el);
      all.push(el);
    }
  }
  const masked: HTMLElement[] = [];
  for (const el of all) {
    if (el === selfIns) continue;
    if (el.dataset.adZoneStash != null) continue; // すでに stash 済み
    el.dataset.adZoneStash = el.getAttribute("data-zoneid") ?? "";
    el.dataset.adClassStash = el.getAttribute("class") ?? "";
    const w = el.getAttribute("width");
    const h = el.getAttribute("height");
    if (w != null) el.dataset.adWidthStash = w;
    if (h != null) el.dataset.adHeightStash = h;
    el.setAttribute("data-zoneid", "");
    el.setAttribute("class", "");
    if (w != null) el.removeAttribute("width");
    if (h != null) el.removeAttribute("height");
    masked.push(el);
  }
  return () => {
    for (const el of masked) {
      const zoneOrig = el.dataset.adZoneStash;
      if (zoneOrig != null) {
        el.setAttribute("data-zoneid", zoneOrig);
        delete el.dataset.adZoneStash;
      }
      const classOrig = el.dataset.adClassStash;
      if (classOrig != null) {
        if (classOrig === "") {
          el.removeAttribute("class");
        } else {
          el.setAttribute("class", classOrig);
        }
        delete el.dataset.adClassStash;
      }
      const wOrig = el.dataset.adWidthStash;
      if (wOrig != null) {
        el.setAttribute("width", wOrig);
        delete el.dataset.adWidthStash;
      }
      const hOrig = el.dataset.adHeightStash;
      if (hOrig != null) {
        el.setAttribute("height", hOrig);
        delete el.dataset.adHeightStash;
      }
    }
  };
}

export default function AdSlot({
  zone,
  className,
  style,
  label = "広告",
  context = "page",
  priority = false,
}: Props) {
  const cfg = AD_ZONES[zone];
  const wrapperRef = useRef<HTMLElement | null>(null);

  const [insKey, setInsKey] = useState(0);
  const [hasContent, setHasContent] = useState(false);

  const hasContentRef = useRef(false);
  const lastBumpAtRef = useRef(0);
  const servedThisGenRef = useRef(false);
  const bumpScheduledRef = useRef(false);
  const hasEnteredViewportRef = useRef(false);

  const enabled = cfg.enabled;

  useLayoutEffect(() => {
    if (!enabled) return;
    // priority モード (モーダル経路) は前回 open の sessionStorage を信用しない。
    // 信用すると「新しい <ins> がまだ空なのに minHeight だけ 250px 確保 + 『広告』
    // ラベルが先に表示される」状態になり、provider のフィル前にユーザに「空の広告枠」
    // が見えてしまうことがあるため。
    if (priority) return;
    if (readWasFilled(zone, context)) {
      setHasContent(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone, context, enabled, priority]);

  useEffect(() => {
    if (!enabled) return;
    // priority モードでは AdIns 側で確実に serve を発火するので、外側の
    // resetAndServeAd は呼ばない。global cooldown と二重 push の影響を避ける。
    if (priority) return;
    const t = window.setTimeout(() => {
      resetAndServeAd(cfg.provider);
    }, 80);
    return () => window.clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestBump = (withProviderReset: boolean) => {
    if (!enabled) return;
    if (hasContentRef.current) return;
    if (bumpScheduledRef.current) return;
    const now = Date.now();
    if (now - lastBumpAtRef.current < 2000) return;
    bumpScheduledRef.current = true;
    requestAnimationFrame(() => {
      bumpScheduledRef.current = false;
      lastBumpAtRef.current = Date.now();
      servedThisGenRef.current = false;
      setInsKey((k) => k + 1);
      if (withProviderReset) {
        resetAndServeAd(cfg.provider);
      }
    });
  };

  useEffect(() => {
    if (!enabled) return;
    // priority モード (モーダル) では popstate / pageshow / visibilitychange を
    // 起点に insKey をバンプしない。理由:
    //   - モーダル open は parent (MovieDetailModal) 側が openInstanceId を
    //     付与した key で AdSlot 全体を一意化する。中で AdIns を bump して
    //     しまうと、最初の `<ins>` (例 adInsId=3) に serve push を出した
    //     直後に key 変更で `<ins>` が detach され、provider が後から
    //     iframe を挿入する宛先がいなくなる。
    //   - 二回目以降の AdIns mount は新しい <ins> でまた serve push する
    //     ので、結果として「provider への push 回数だけ増えて creative は
    //     1 つも見えない」状態になる (実観測 PR #128 後ログ)。
    // 通常ページ (priority=false) は従来通り bump する。これは「ホーム ↔
    // 詳細ページ」のソフトナビ後に SPA で <ins> が DOM 残置されているケース
    // の救済として実績がある。
    if (priority) return;
    const onPopState = () => requestBump(true);
    const onPageShow = (e: PageTransitionEvent) => { void e.persisted; requestBump(true); };
    const onVisibility = () => { if (document.visibilityState === "visible") requestBump(false); };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, priority]);

  if (!isAdZoneEnabled(zone)) return null;

  // priority モード (モーダル) では、provider が iframe を `<ins>` に挿入する
  // タイミングと我々の MutationObserver が hasContent=true にフリップする
  // タイミングの間に「iframe は来ているが wrapper minHeight=1px + overflow:hidden
  // でクリップされ画面に見えない」というラグが起きる可能性がある。
  // priority のときは reservedHeight をはじめから確保しておく (label だけは
  // hasContent=true まで出さないので、PR #123 で禁じた「空枠の "広告" ラベル
  // 先行表示」は発生しない)。
  const reserveHeightUpfront = priority && cfg.reservedHeight != null;
  const wrapperStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    background: "transparent",
    minHeight: reserveHeightUpfront
      ? `${cfg.reservedHeight}px`
      : hasContent && cfg.reservedHeight != null
        ? `${cfg.reservedHeight}px`
        : "1px",
    // priority のときは wrapper を overflow:visible にして「provider が iframe を
    // `<ins>` の外 (= wrapper 直下) に挿入する rare バリエーション」でも見える
    // ようにしておく。非 priority は従来通り CLS 抑止のため overflow:hidden。
    overflow: reserveHeightUpfront ? "visible" : "hidden",
    ...style,
  };

  return (
    <aside
      ref={wrapperRef as React.RefObject<HTMLElement>}
      className={`ad-slot ad-slot-${zone}${className ? ` ${className}` : ""}`}
      style={wrapperStyle}
      aria-label={label ?? undefined}
      role="complementary"
    >
      {label && hasContent && (
        <span
          style={{
            fontSize: 12,           /* 10px → 12px に大きく */
            color: "rgba(255,255,255,0.45)",
            letterSpacing: "0.08em",
            marginBottom: 6,
            alignSelf: "center",
          }}
        >
          {label}
        </span>
      )}
      <AdIns
        key={insKey}
        cfg={cfg}
        priority={priority}
        servedThisGenRef={servedThisGenRef}
        hasEnteredViewportRef={hasEnteredViewportRef}
        onContent={() => {
          hasContentRef.current = true;
          writeWasFilled(zone, context);
          setHasContent(true);
        }}
        onBecameVisibleAgain={() => {
          requestBump(false);
        }}
      />
    </aside>
  );
}

// adDebug 用のグローバル ID カウンタ。AdIns が mount するたびにインクリメントして
// 各 <ins> インスタンスに data-ad-ins-id を打つ。debug log でモーダル N 回目の
// <ins> がどれか・どの <ins> に iframe が入ったか追跡する用。
let nextAdInsId = 1;

function AdIns({
  cfg,
  priority,
  servedThisGenRef,
  hasEnteredViewportRef,
  onContent,
  onBecameVisibleAgain,
}: {
  cfg: (typeof AD_ZONES)[AdZoneKey];
  priority: boolean;
  servedThisGenRef: React.MutableRefObject<boolean>;
  hasEnteredViewportRef: React.MutableRefObject<boolean>;
  onContent: () => void;
  onBecameVisibleAgain: () => void;
}) {
  const insRef = useRef<HTMLModElement | null>(null);
  const insIdRef = useRef<number>(0);

  useEffect(() => {
    const el = insRef.current;
    if (!el) return;

    // インスタンス ID を付ける (debug 用)。
    insIdRef.current = nextAdInsId++;
    el.dataset.adInsId = String(insIdRef.current);

    let cancelled = false;
    let contentSeen = false;

    const insHasAd = (): boolean =>
      !!el.querySelector("iframe, img, video, a, picture, canvas");

    // provider のごく一部のレンダラーは iframe を `<ins>` 内部ではなく
    // 親 (`<aside class="ad-slot">`) 直下に挿入することがある。その場合でも
    // 「広告は来ている」状態としたいので、`<ins>` の親を一つ上まで MO の
    // 観測対象に含める。
    const moTarget: HTMLElement = (el.parentElement as HTMLElement) ?? el;
    const containerHasAd = (): boolean =>
      !!moTarget.querySelector("iframe, img, video, a, picture, canvas");

    // priority 経路では「contentSeen 検知時に retry timer を全てキャンセル + mask 復元」
    // を一括で行うフック。 priority ブロック内で実装したい本体ロジックがあるため、
    // 最初は null で、 priority ブロック実行時に差し込む。
    let onContentDetected: ((reason: string) => void) | null = null;

    const mo = new MutationObserver(() => {
      if (cancelled) return;
      if (contentSeen) return;
      if (!(insHasAd() || containerHasAd())) return;
      if (onContentDetected) {
        onContentDetected("mutation-observer");
      } else {
        contentSeen = true;
        onContent();
        mo.disconnect();
      }
    });
    mo.observe(moTarget, { childList: true, subtree: true });

    // ---- priority モード (モーダルなど): 多段リトライ + 競合 <ins> mask ----
    if (priority) {
      const timers: number[] = [];
      let rafA = 0;
      let rafB = 0;
      // 自分の <ins> が viewport に入ったら true。 ExoClick の creative iframe は
      // ロード直後に自前の IntersectionObserver / Page Visibility API で
      // 「Visibility: hidden」と判定したら polling を止めて二度と再開しない実装
      // が観測されているため、iframe がロードされる瞬間に <ins> が viewport に
      // 入っている必要がある。モーダル末尾の <ins> はモーダルを開いた直後は
      // スクロール下にあるので、IO の交差を待ってから serve push を出す。
      let firstServeStarted = false;
      // priority モード内の累積 serve push 回数。再試行ループが暴走していないか
      // 後から見るための debug ログ用。
      let servePushCount = 0;

      // mask の累積復元クロージャ。
      // 以前は serveWithMask の各回で「250ms 後に復元」していたが、provider の
      // api.php → renderer script ロード → iframe inject まで 500ms〜数秒
      // かかることがある (特に 2 回目以降の modal open / モバイル回線時)。
      // 復元タイミングが injection より先に来ると provider が背後 (フィードの
      // FeedAdSlide) `<ins>` を target にして iframe をそこに入れ、モーダルは
      // 永遠に空のまま、という症状になる。
      //
      // 解決: contentSeen=true (= 自分の `<ins>` に iframe が来た) もしくは
      // AdSlot unmount のタイミングまで mask を保持する。複数回 serveWithMask
      // が呼ばれても maskCompetingInsElements 自身が二重 stash をスキップする
      // ので、累積で 1 回しか stash されない。
      const restoreFns: Array<() => void> = [];
      const restoreAll = () => {
        while (restoreFns.length > 0) {
          const fn = restoreFns.pop();
          if (fn) {
            try {
              fn();
            } catch {
              /* ignore */
            }
          }
        }
      };

      // 予約済みのリトライ timer を全てキャンセルする。 contentSeen 検知時に
      // 呼んで「埋まったあとも push が連発する」症状を止める。
      const cancelPendingRetries = () => {
        while (timers.length > 0) {
          const id = timers.pop();
          if (id != null) window.clearTimeout(id);
        }
      };

      const handleContentSeen = (reason: string) => {
        if (contentSeen) return;
        contentSeen = true;
        onContent();
        restoreAll();
        cancelPendingRetries();
        mo.disconnect();
        adDebugLog("priority content seen", {
          reason,
          adInsId: insIdRef.current,
          zoneId: cfg.zoneId,
          selfHasIframe: !!el.querySelector("iframe"),
          childCount: el.children.length,
          innerHTMLLength: el.innerHTML.length,
          servePushCount,
        });
        dumpInsForZone(cfg.zoneId, "after-content", cfg.insClass);
      };

      const serveWithMask = (source: string) => {
        if (cancelled) return;
        if (contentSeen) return;
        if (insHasAd() || containerHasAd()) {
          // すでに iframe / img / video が入った状態でここに来た = MO が
          // フリップする前に retry timer が走ったケース。 contentSeen を
          // 立てて以降の push を全て止める。
          handleContentSeen(`serveWithMask:${source}:content-already-present`);
          return;
        }
        const restore = maskCompetingInsElements(cfg.zoneId, cfg.insClass, el);
        restoreFns.push(restore);
        // serve 時の `<ins>` の見え方を全てログに残す。 creative iframe が
        // 「Visibility: hidden」で polling を止める症状の調査に必要。
        const rect = el.getBoundingClientRect();
        const cs = typeof window !== "undefined" ? window.getComputedStyle(el) : null;
        const parentRect = el.parentElement?.getBoundingClientRect();
        const parentCs = el.parentElement && typeof window !== "undefined"
          ? window.getComputedStyle(el.parentElement)
          : null;
        servePushCount++;
        adDebugLog("priority serve push", {
          source,
          servePushCount,
          adInsId: insIdRef.current,
          zoneId: cfg.zoneId,
          insClass: cfg.insClass,
          insInDom: !!el.isConnected,
          dataZoneId: el.getAttribute("data-zoneid"),
          sameZoneInsCount: document.querySelectorAll(
            `ins[data-zoneid="${cfg.zoneId}"]`,
          ).length,
          sameClassInsCount: document.querySelectorAll(
            `ins.${cfg.insClass}`,
          ).length,
          childCount: el.children.length,
          hasIframe: !!el.querySelector("iframe"),
          innerHTMLLength: el.innerHTML.length,
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          inViewportY: rect.bottom > 0 && rect.top < window.innerHeight,
          insStyle: cs ? { display: cs.display, visibility: cs.visibility, opacity: cs.opacity } : null,
          parentRect: parentRect
            ? { x: parentRect.x, y: parentRect.y, w: parentRect.width, h: parentRect.height }
            : null,
          parentStyle: parentCs
            ? { display: parentCs.display, visibility: parentCs.visibility, opacity: parentCs.opacity, overflow: parentCs.overflow }
            : null,
          documentVisibility: typeof document !== "undefined" ? document.visibilityState : null,
        });
        serveAd(cfg.provider);
        // serve push 直後は <ins> が空でも問題ない。 provider が iframe を
        // 挿入するのに 数百ms〜数秒かかるため、 +0.5s / +1.5s / +3s で同じ
        // <ins> の状態を再ダンプして「provider success 後の DOM 上で本当に
        // iframe が来たか / 来たならどこに入ったか」を後追いする。
        // contentSeen / cancelled なら no-op。 timers に積んでおき unmount で
        // 確実にキャンセル。
        for (const delay of [500, 1500, 3000]) {
          const id = window.setTimeout(() => {
            if (cancelled || contentSeen) return;
            const rect2 = el.getBoundingClientRect();
            adDebugLog("priority post-serve snapshot", {
              source,
              delayMs: delay,
              adInsId: insIdRef.current,
              servePushCount,
              insConnected: el.isConnected,
              hasIframe: !!el.querySelector("iframe"),
              hasImg: !!el.querySelector("img"),
              childCount: el.children.length,
              innerHTMLLength: el.innerHTML.length,
              dataZoneId: el.getAttribute("data-zoneid"),
              rect: { x: rect2.x, y: rect2.y, w: rect2.width, h: rect2.height },
            });
            dumpInsForZone(cfg.zoneId, `post-serve+${delay}ms`, cfg.insClass);
          }, delay);
          timers.push(id);
        }
      };

      // contentSeen を「retry timer 起点」でも検知できるよう、各 retry の
      // 入り口でチェックして既に埋まっていたら no-op にする。これで provider
      // が iframe を挿入したのに MO 通知が遅れて retry が走ってしまうケース
      // でも、二重 push を防げる。
      const scheduleRetry = (delay: number, source: string) => {
        const id = window.setTimeout(() => {
          if (cancelled) return;
          if (contentSeen) return;
          if (insHasAd() || containerHasAd()) {
            adDebugLog("priority retry skipped", {
              source,
              reason: "content-present",
              adInsId: insIdRef.current,
              childCount: el.children.length,
              hasIframe: !!el.querySelector("iframe"),
            });
            handleContentSeen(`retry:${source}:content-present`);
            return;
          }
          serveWithMask(source);
        }, delay);
        timers.push(id);
      };

      // MO の content 検知を priority 用 handler に向ける。MO は要素登録済みなので
      // ここで onContentDetected を差し替えるだけで、以降の mutation 通知は
      // handleContentSeen 経由 (= retry timer cancel + mask restore + ログ) になる。
      onContentDetected = handleContentSeen;

      hasEnteredViewportRef.current = true;
      adDebugLog("priority mount", {
        adInsId: insIdRef.current,
        zoneId: cfg.zoneId,
        provider: cfg.provider,
        insClass: cfg.insClass,
      });
      dumpInsForZone(cfg.zoneId, "mount", cfg.insClass);

      // <ins> が viewport に入ってから serve push を出すフロー。
      //
      // 背景: 直近のリアル端末ログで「Request 成功 → banner.js 初期化 → iframe
      // model fetch 成功 → [Banner Debug] Visibility: hidden → Stopping polling」
      // の流れが観測されている。 modal 末尾の <ins> はモーダルを開いた直後は
      // スクロール下 (viewport の外) にあるため、 creative の self-visibility
      // 判定 (IntersectionObserver / Page Visibility API ベース) が「自分は
      // hidden」と判断し、 polling を恒久停止してしまう。
      //
      // 対策: <ins> が viewport に入った瞬間に最初の serve push を出す。
      // この時点で creative iframe がロードされても自分は表示中なので
      // hidden 判定にならない。 8 秒経っても viewport に入らなかった場合は
      // 「ユーザが modal 内をスクロールせず閉じる」ケースとみなして
      // フォールバックで push する (serve イベント自体はカウントしておきたい)。
      const beginPriorityServe = (reason: string) => {
        if (cancelled || contentSeen || firstServeStarted) return;
        firstServeStarted = true;
        adDebugLog("priority first serve", { reason, adInsId: insIdRef.current });
        serveWithMask("first");
        // 再試行は 2 回に絞る (PR #128 までは 1.0s / 2.5s / 4.0s の 3 回 +
        // 8s fallback restore で、provider が静かに no-fill を返した場合に
        // 計 4 回も serve push が出ていた)。各 retry の入り口で contentSeen
        // と insHasAd() を確認するので、埋まっていれば即座に no-op になる。
        scheduleRetry(2000, "retry-2s");
        scheduleRetry(5000, "retry-5s");
        // モーダル広告 unfilled でも背後 `<ins>` をいつまでも mask した
        // ままにすると、modal close 後にフィード広告が空になる。最大 8s
        // でフォールバック restore する (provider がこの時間内に inject
        // しないなら今回の serve は諦め、フィード側は通常動作に戻す)。
        timers.push(window.setTimeout(() => {
          adDebugLog("priority mask fallback restore", {
            adInsId: insIdRef.current,
            contentSeen,
            servePushCount,
          });
          restoreAll();
        }, 8000));
      };

      // モーダル open 直後でも、 mdm-scroll の縦サイズが充分大きく
      // <ins> がたまたま viewport 内に入る可能性 (タブレット等) や、
      // ユーザがすでにフィード側で同 zone を見ていて scroll 0 から
      // <ins> が見えるケースもあるため、 mount 直後の rect で
      // 一度判定する。
      const isInViewportNow = (): boolean => {
        const r = el.getBoundingClientRect();
        const vh =
          window.innerHeight || document.documentElement.clientHeight || 0;
        const vw =
          window.innerWidth || document.documentElement.clientWidth || 0;
        // rect が 0x0 の場合は「まだレイアウト前」とみなして false。
        if (r.width === 0 && r.height === 0) return false;
        return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      };

      rafA = requestAnimationFrame(() => {
        rafB = requestAnimationFrame(() => {
          if (cancelled) return;
          if (isInViewportNow()) {
            beginPriorityServe("in-viewport-on-mount");
          }
        });
      });

      // IntersectionObserver。 <ins> が viewport に入った瞬間に serve push。
      // rootMargin は「下から少し早めに」拾う程度 (50px) に抑える。 200px だと
      // ユーザがまだ <ins> を見ていない段階で creative iframe をロードして
      // しまい、結局 hidden 判定で polling を止められるリスクがある。
      const io = new IntersectionObserver(
        (entries) => {
          if (cancelled) return;
          if (contentSeen) return;
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            if (!firstServeStarted) {
              beginPriorityServe("intersection");
            }
            // viewport に再入したときの「保険 push」は廃止。 retry timer
            // (2s, 5s) と mask による競合排除が走っているので、これ以上
            // 上から push を重ねる理由はない (PR #128 のログで観測された
            // 「同じ <ins> に 5 連続 serve push」を防ぐため)。
          }
        },
        { rootMargin: "50px 0px", threshold: 0.01 },
      );
      io.observe(el);

      // ユーザがモーダル内を全くスクロールせずに閉じるケースのフォールバック。
      // 8 秒経っても viewport に入らなければ強制的に serve する (この場合は
      // creative が hidden 判定で polling を止める可能性があるが、 request は
      // 発生させておきたい)。
      timers.push(
        window.setTimeout(() => {
          if (!firstServeStarted) {
            beginPriorityServe("fallback-8s");
          }
        }, 8000),
      );

      if (insHasAd() || containerHasAd()) {
        handleContentSeen("mount-init");
      }

      return () => {
        cancelled = true;
        mo.disconnect();
        io.disconnect();
        if (rafA) cancelAnimationFrame(rafA);
        if (rafB) cancelAnimationFrame(rafB);
        cancelPendingRetries();
        // unmount 時に必ず競合 `<ins>` の data-zoneid を戻す。
        // restoreAll は冪等 (空キューなら no-op)。
        restoreAll();
      };
    }

    // ---- 非 priority (通常ページ): 従来通り IO で serve をゲートする ----
    let serveStarted = false;
    let collapseTimer: number | null = null;
    let retryTimer: number | null = null;
    let emptyEmitted = false;

    const tryServeOnce = () => {
      if (servedThisGenRef.current) return;
      servedThisGenRef.current = true;
      serveAd(cfg.provider);
    };

    const beginServeFlow = () => {
      if (serveStarted) return;
      serveStarted = true;
      hasEnteredViewportRef.current = true;
      tryServeOnce();
      retryTimer = window.setTimeout(() => {
        if (cancelled || contentSeen) return;
        if (!insHasAd() && !containerHasAd()) serveAd(cfg.provider);
      }, 700);
      collapseTimer = window.setTimeout(() => {
        if (cancelled || contentSeen) return;
        if (!insHasAd() && !containerHasAd() && !emptyEmitted) {
          emptyEmitted = true;
        }
      }, 4000);
    };

    const io = new IntersectionObserver(
      (entries) => {
        if (cancelled) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (!serveStarted) {
            beginServeFlow();
          } else if (emptyEmitted && !contentSeen) {
            onBecameVisibleAgain();
          }
        }
      },
      { rootMargin: "200px 0px", threshold: 0.01 },
    );
    io.observe(el);

    if (insHasAd() || containerHasAd()) {
      contentSeen = true;
      onContent();
      mo.disconnect();
    }

    return () => {
      cancelled = true;
      mo.disconnect();
      io.disconnect();
      if (retryTimer != null) window.clearTimeout(retryTimer);
      if (collapseTimer != null) window.clearTimeout(collapseTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const widthVal = cfg.reservedWidth != null ? `${cfg.reservedWidth}px` : "100%";

  const insStyle: React.CSSProperties = {
    display: "block",
    background: "transparent",
    maxWidth: "100%",
    overflow: "hidden",
    boxSizing: "border-box",
    width: widthVal,
  };

  // ExoClick の renderer (`https://a.magsrv.com/content/banner.js`) は
  // 一部バリエーションで `<ins>` の `width` / `height` 属性を読んで iframe
  // 寸法を決める。CSS の `style="width: 300px"` だけだと拾い損ねるケースが
  // あるため、reservedWidth / reservedHeight があるときは HTML 属性としても
  // セットしておく (300x250 / 300x100 など固定サイズの zone 用)。
  const insAttrs: Record<string, string | number> = {};
  if (cfg.reservedWidth != null) insAttrs.width = cfg.reservedWidth;
  if (cfg.reservedHeight != null) insAttrs.height = cfg.reservedHeight;

  return (
    <ins
      ref={insRef as React.RefObject<HTMLModElement>}
      className={cfg.insClass}
      data-zoneid={cfg.zoneId}
      style={insStyle}
      {...insAttrs}
    />
  );
}
