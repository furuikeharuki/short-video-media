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

  const wrapperStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    maxWidth: "100%",
    overflow: "hidden",
    boxSizing: "border-box",
    background: "transparent",
    minHeight:
      hasContent && cfg.reservedHeight != null
        ? `${cfg.reservedHeight}px`
        : "1px",
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

    const mo = new MutationObserver(() => {
      if (cancelled) return;
      if (!contentSeen && insHasAd()) {
        contentSeen = true;
        onContent();
        mo.disconnect();
      }
    });
    mo.observe(el, { childList: true, subtree: true });

    // ---- priority モード (モーダルなど): 多段リトライ + 競合 <ins> mask ----
    if (priority) {
      const timers: number[] = [];
      let rafA = 0;
      let rafB = 0;

      const serveWithMask = () => {
        if (cancelled || contentSeen) return;
        if (insHasAd()) {
          if (!contentSeen) {
            contentSeen = true;
            onContent();
          }
          return;
        }
        const restore = maskCompetingInsElements(cfg.zoneId, el);
        serveAd(cfg.provider);
        // 250ms 経てば provider のスキャンはほぼ完了する。
        // それ以前に restore してしまうと provider が他の <ins> を見つけて
        // モーダル枠を素通りする可能性があるため。
        const restoreId = window.setTimeout(restore, 250);
        timers.push(restoreId);
      };

      hasEnteredViewportRef.current = true;
      // rAF を 2 回挟んでブラウザのレイアウトを確定させてから serve する。
      // モーダルのトランジション完了直後 (まだ <ins> が viewport 外) でも
      // priority mode は IO を待たずに serve するので問題ない。
      rafA = requestAnimationFrame(() => {
        rafB = requestAnimationFrame(() => {
          if (cancelled) return;
          serveWithMask();
          // 1.0s / 2.5s の再試行。各回ごとに mask + restore。
          // provider script のロード遅延、初回 push が他要素に取られた等の
          // ケースをカバーする。content が来たら serveWithMask 内で no-op になる。
          timers.push(window.setTimeout(serveWithMask, 1000));
          timers.push(window.setTimeout(serveWithMask, 2500));
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

      if (insHasAd()) {
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
        if (!insHasAd()) serveAd(cfg.provider);
      }, 700);
      collapseTimer = window.setTimeout(() => {
        if (cancelled || contentSeen) return;
        if (!insHasAd() && !emptyEmitted) {
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

    if (insHasAd()) {
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

  return (
    <ins
      ref={insRef as React.RefObject<HTMLModElement>}
      className={cfg.insClass}
      data-zoneid={cfg.zoneId}
      style={insStyle}
    />
  );
}
