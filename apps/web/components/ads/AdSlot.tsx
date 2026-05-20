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
   * モーダルなど「他にも同じ zone の <ins> が既に DOM にある状況で開く AdSlot」
   * 用のフラグ。true のとき:
   *  - IntersectionObserver が intersecting と見なせないまま (スクロール下にある等)
   *    でも mount 直後に serve を試みる。
   *  - serve push の直前に、この AdSlot の <ins> 以外で同じ zoneid を持つ
   *    `<ins>` の data-zoneid を一時的に退避し、provider がこの slot の <ins>
   *    を優先的に拾うようにする。完了後すぐ復元する。
   *
   * 用途: 詳細モーダルの広告。背後にフィードの FeedAdSlide が同じ zoneid で
   *       いくつも残っているため、何もしないと provider がそちらに serve を
   *       消費してしまいモーダルの <ins> が空のまま残る。
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
 * 退避は data-zoneid を ad_zone_stash 属性に逃がし、data-zoneid を空にすることで行う。
 * 復元用の関数を返す。複数回呼ばれた場合に矛盾しないよう、stash 済みかどうかを
 * 個別に判定する。
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
    if (el.dataset.adZoneStash != null) continue; // 既に他で stash 済み
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
  const [emptyGen, setEmptyGen] = useState(false);

  const hasContentRef = useRef(false);
  const lastBumpAtRef = useRef(0);
  const servedThisGenRef = useRef(false);
  const bumpScheduledRef = useRef(false);
  const hasEnteredViewportRef = useRef(false);

  const enabled = cfg.enabled;

  useLayoutEffect(() => {
    if (!enabled) return;
    if (readWasFilled(zone, context)) {
      setHasContent(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone, context, enabled]);

  useEffect(() => {
    if (!enabled) return;
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
      setEmptyGen(false);
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
          setEmptyGen(false);
        }}
        onEmpty={() => {
          setEmptyGen(true);
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
  onEmpty,
  onBecameVisibleAgain,
}: {
  cfg: (typeof AD_ZONES)[AdZoneKey];
  priority: boolean;
  servedThisGenRef: React.MutableRefObject<boolean>;
  hasEnteredViewportRef: React.MutableRefObject<boolean>;
  onContent: () => void;
  onEmpty: () => void;
  onBecameVisibleAgain: () => void;
}) {
  const insRef = useRef<HTMLModElement | null>(null);

  useEffect(() => {
    const el = insRef.current;
    if (!el) return;

    let cancelled = false;
    let contentSeen = false;
    let emptyEmitted = false;

    const insHasAd = (): boolean =>
      !!el.querySelector("iframe, img, video, a, picture, canvas");

    /**
     * priority モードでは「この AdSlot の <ins> 以外で同じ zoneid を持つ <ins>」を
     * 一時的に DOM 上で隠して serve を呼ぶ。これにより provider が背後のフィード
     * AdSlot などに serve を取られるのを避け、モーダルの <ins> を確実に埋める。
     * 復元は短い遅延 (250ms) のあとに行い、provider のスキャンが終わるのを待つ。
     */
    const tryServeOnce = () => {
      if (servedThisGenRef.current) return;
      servedThisGenRef.current = true;
      if (priority) {
        const restore = maskCompetingInsElements(cfg.zoneId, el);
        serveAd(cfg.provider);
        window.setTimeout(restore, 250);
      } else {
        serveAd(cfg.provider);
      }
    };

    const mo = new MutationObserver(() => {
      if (cancelled) return;
      if (!contentSeen && insHasAd()) {
        contentSeen = true;
        onContent();
        mo.disconnect();
      }
    });
    mo.observe(el, { childList: true, subtree: true });

    let serveStarted = false;
    let collapseTimer: number | null = null;
    let retryTimer: number | null = null;
    let priorityRetryTimer: number | null = null;

    const beginServeFlow = () => {
      if (serveStarted) return;
      serveStarted = true;
      hasEnteredViewportRef.current = true;
      tryServeOnce();
      retryTimer = window.setTimeout(() => {
        if (cancelled || contentSeen) return;
        if (!insHasAd()) {
          if (priority) {
            const restore = maskCompetingInsElements(cfg.zoneId, el);
            serveAd(cfg.provider);
            window.setTimeout(restore, 250);
          } else {
            serveAd(cfg.provider);
          }
        }
      }, 700);
      collapseTimer = window.setTimeout(() => {
        if (cancelled || contentSeen) return;
        if (!insHasAd() && !emptyEmitted) {
          emptyEmitted = true;
          onEmpty();
        }
      }, 4000);
    };

    // priority モード: モーダルなど IntersectionObserver が intersecting と
    // 認識しづらいレイアウト (スクロール下に置かれた <ins>、creative ロード前で
    // height=0 等) でも確実に serve を発火させるため、mount 直後に
    // requestAnimationFrame 2 回 (= レイアウト確定) を待ってから serve を開始する。
    if (priority) {
      let raf1 = 0;
      let raf2 = 0;
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          if (cancelled) return;
          beginServeFlow();
          // それでも 1.2s で creative が来ていなければ「provider が別の <ins>
          // に serve を消費した」可能性が高いので一度だけ再試行する。
          priorityRetryTimer = window.setTimeout(() => {
            if (cancelled || contentSeen) return;
            if (!insHasAd()) {
              const restore = maskCompetingInsElements(cfg.zoneId, el);
              serveAd(cfg.provider);
              window.setTimeout(restore, 250);
            }
          }, 1200);
        });
      });

      const io = new IntersectionObserver(
        (entries) => {
          if (cancelled) return;
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            if (emptyEmitted && !contentSeen) {
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
        if (raf1) cancelAnimationFrame(raf1);
        if (raf2) cancelAnimationFrame(raf2);
        if (retryTimer != null) window.clearTimeout(retryTimer);
        if (collapseTimer != null) window.clearTimeout(collapseTimer);
        if (priorityRetryTimer != null) window.clearTimeout(priorityRetryTimer);
      };
    }

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
