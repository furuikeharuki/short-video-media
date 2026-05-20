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
 */
function isAdDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.localStorage?.getItem("adDebug") === "1") return true;
    const params = new URLSearchParams(window.location.search);
    return params.get("adDebug") === "1";
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
function dumpInsForZone(zoneId: string, label: string): void {
  if (!isAdDebugEnabled() || typeof document === "undefined") return;
  const live = Array.from(
    document.querySelectorAll<HTMLElement>(`ins[data-zoneid="${zoneId}"]`),
  );
  const stashed = Array.from(
    document.querySelectorAll<HTMLElement>(
      `ins[data-ad-zone-stash="${zoneId}"]`,
    ),
  );
  const all = [...live, ...stashed];
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
      connected: el.isConnected,
      dataZoneId: el.getAttribute("data-zoneid"),
      stash: el.dataset.adZoneStash ?? null,
      cls: el.className,
      hasIframe: !!el.querySelector("iframe"),
      iframeSrc: el.querySelector("iframe")?.getAttribute("src") ?? null,
      childCount: el.children.length,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      parents,
    };
  });
  // eslint-disable-next-line no-console
  console.log(`[AdSlot:dump:${label}] zone=${zoneId} count=${all.length}`, dump);
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
 * `selfIns` 以外で同じ zoneid を持つ `<ins>` を一時的に「provider から見えなく」する。
 *
 * data-zoneid を data-ad-zone-stash に逃がし、data-zoneid を空にする。
 * 復元用クロージャを返す。複数回呼ばれて二重 stash しないよう、すでに stash 済みの
 * 要素はスキップする (二重 stash で本来値を失わないため)。
 *
 * 復元は冪等。stash されていない要素はそのまま。
 */
function maskCompetingInsElements(
  zoneId: string,
  selfIns: HTMLElement | null,
): () => void {
  if (typeof document === "undefined" || !zoneId) return () => {};
  const all = Array.from(
    document.querySelectorAll<HTMLElement>(`ins[data-zoneid="${zoneId}"]`),
  );
  const masked: HTMLElement[] = [];
  for (const el of all) {
    if (el === selfIns) continue;
    if (el.dataset.adZoneStash != null) continue; // すでに stash 済み
    el.dataset.adZoneStash = zoneId;
    el.setAttribute("data-zoneid", "");
    masked.push(el);
  }
  return () => {
    for (const el of masked) {
      const original = el.dataset.adZoneStash;
      if (original) {
        el.setAttribute("data-zoneid", original);
        delete el.dataset.adZoneStash;
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
  }, [enabled]);

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

  useEffect(() => {
    const el = insRef.current;
    if (!el) return;

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

    const mo = new MutationObserver(() => {
      if (cancelled) return;
      if (!contentSeen && (insHasAd() || containerHasAd())) {
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

      const serveWithMask = () => {
        if (cancelled) return;
        if (insHasAd() || containerHasAd()) {
          if (!contentSeen) {
            contentSeen = true;
            onContent();
          }
          // 自身に iframe が来たので競合 mask は不要に。
          restoreAll();
          dumpInsForZone(cfg.zoneId, "after-content");
          return;
        }
        const restore = maskCompetingInsElements(cfg.zoneId, el);
        restoreFns.push(restore);
        adDebugLog("priority serve push", {
          zoneId: cfg.zoneId,
          insInDom: !!el.isConnected,
          dataZoneId: el.getAttribute("data-zoneid"),
        });
        serveAd(cfg.provider);
      };

      hasEnteredViewportRef.current = true;
      adDebugLog("priority mount", {
        zoneId: cfg.zoneId,
        provider: cfg.provider,
      });
      dumpInsForZone(cfg.zoneId, "mount");
      // rAF を 2 回挟んでブラウザのレイアウトを確定させてから serve する。
      // モーダルのトランジション完了直後 (まだ <ins> が viewport 外) でも
      // priority mode は IO を待たずに serve するので問題ない。
      rafA = requestAnimationFrame(() => {
        rafB = requestAnimationFrame(() => {
          if (cancelled) return;
          serveWithMask();
          // 1.0s / 2.5s / 4.0s の再試行。各回 serveWithMask で mask が
          // 累積復元キューに積まれ、contentSeen で一括 restore される。
          // provider script のロード遅延、初回 push が他要素に取られた等の
          // ケースをカバーする。
          timers.push(window.setTimeout(serveWithMask, 1000));
          timers.push(window.setTimeout(serveWithMask, 2500));
          timers.push(window.setTimeout(serveWithMask, 4000));
          // モーダル広告 unfilled でも背後 `<ins>` をいつまでも mask した
          // ままにすると、modal close 後にフィード広告が空になる。最大 8s
          // でフォールバック restore する (provider がこの時間内に inject
          // しないなら今回の serve は諦め、フィード側は通常動作に戻す)。
          timers.push(window.setTimeout(() => {
            adDebugLog("priority mask fallback restore");
            restoreAll();
          }, 8000));
        });
      });

      // priority モードでも IO は残しておく。一度 onEmpty に落ちて
      // (本実装では明示的に onEmpty を出さないが) ユーザが再度この枠に
      // スクロールしてきた等で再試行のチャンスにする用。
      const io = new IntersectionObserver(
        (entries) => {
          if (cancelled || contentSeen) return;
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            // 既にリトライ予定はキューしてあるので追加 push は不要。
            // 万一それらもタイミング外しで空振りした場合の最後の保険として
            // ここでも serve を試みる。
            serveWithMask();
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
        if (rafA) cancelAnimationFrame(rafA);
        if (rafB) cancelAnimationFrame(rafB);
        for (const t of timers) window.clearTimeout(t);
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
