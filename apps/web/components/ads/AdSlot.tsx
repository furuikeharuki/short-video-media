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

export default function AdSlot({
  zone,
  className,
  style,
  label = "広告",
  context = "page",
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

/**
 * ExoClick の Recommendation Widget (eas6a97888e20) は <ins> の中に
 * <div> / <a> / <iframe> / <img> を入れ子で生成し、内部 grid wrapper や
 * カード要素にインライン style で固定 px 幅 (例: width:300px) を当てる。
 *
 * これが特に実機スマホで顕著に発生し、CSS 側で .ad-slot ins * に
 * `max-width:100% !important` を当ててもインライン style の `width:300px`
 * が優先される (max-width は max しか縛らないため "300px" は通過する)。
 * 結果としてスマホの 360px 幅コンテナの中で widget が 300px 固定で描画され、
 * 中の thumbnail が並んで全体が小さく見える状態になる。
 *
 * 対策: widget が <ins> に DOM を流し込んだあとに走らせる
 * 「インライン width 強制剥がし + 直下子要素を 100% に固定」する正規化。
 * これにより widget が後から描いた要素のインライン style を上書きできる。
 *
 * MutationObserver で短時間 (最大 6 秒) 監視し、widget が遅延描画する
 * 要素にも追従する。unmount 時は cleanup される。
 */
function normalizeAdContent(insEl: HTMLElement): void {
  const ins = insEl;
  // 1) 子孫要素のインライン width / max-width / min-width を剥がす。
  //    これで widget が内部 wrapper / card に当てた固定 px 幅 (300px 等) が
  //    無効化され、外側の CSS / flex layout で素直に親幅まで広げられる。
  //    <img> の style.width も剥がす (=>CSS の width:100% に従って親幅追従)。
  //    <img> の width 属性は触らない (aspect-ratio 計算に必要)。
  const descendants = ins.querySelectorAll<HTMLElement>("*");
  for (const d of descendants) {
    const s = d.style;
    if (s.width) s.removeProperty("width");
    if (s.maxWidth) s.removeProperty("max-width");
    if (s.minWidth) s.removeProperty("min-width");
  }
  // 2) ins 直下の root wrapper をインラインで親幅に固定。
  //    インラインなので CSS の `width:100% !important` よりも更に確実に効き、
  //    widget が後から style を書き直しても MutationObserver で再上書きされる。
  for (const child of Array.from(ins.children) as HTMLElement[]) {
    child.style.setProperty("width", "100%", "important");
    child.style.setProperty("max-width", "100%", "important");
    child.style.setProperty("box-sizing", "border-box", "important");
  }
  // 3) 内部 card grid の幅が intrinsic に小さい (= zone 側で小さい画像サイズが
  //    選ばれている) ケースの強制拡大。
  //    ins 内の <a> カードを直接の親に持つ最初の container を見つけ、
  //    まだ ins 幅より狭ければ flex-row で各カードを均等に広げる。
  const insWidth = ins.clientWidth;
  if (insWidth <= 0) return;
  const anchors = ins.querySelectorAll<HTMLAnchorElement>("a");
  if (anchors.length < 1) return;
  // 全 <a> に共通の親 (= grid container) を探す。
  const firstParent = anchors[0].parentElement;
  if (!firstParent || !ins.contains(firstParent)) return;
  const allShareParent = Array.from(anchors).every(
    (a) => a.parentElement === firstParent,
  );
  if (!allShareParent) return;
  // カード合計幅が ins 幅に比べて明確に狭い場合 (zone が小さい thumb サイズで
  // 設定されているケース) に flex 伸縮を発動させる。
  // (firstParent 自体は width:100% を継承して ins 幅と一致しているため、
  //  そこではなく card 群の実合計幅で判定する。)
  let cardsTotalWidth = 0;
  for (const a of Array.from(anchors)) {
    const rect = a.getBoundingClientRect();
    cardsTotalWidth += rect.width;
  }
  if (!Number.isFinite(cardsTotalWidth) || cardsTotalWidth <= 0) return;
  if (cardsTotalWidth < insWidth * 0.85) {
    // grid 自体を flex 横並びにし、各 <a> を均等に広げる。
    // gap は 6px を確保。子の元レイアウトを大きく崩さないために
    // 既存 display が flex/grid なら触らない。
    const cs = window.getComputedStyle(firstParent);
    if (cs.display !== "flex" && cs.display !== "grid") {
      firstParent.style.setProperty("display", "flex", "important");
      firstParent.style.setProperty("flex-direction", "row", "important");
      firstParent.style.setProperty("flex-wrap", "wrap", "important");
      firstParent.style.setProperty("gap", "6px", "important");
      firstParent.style.setProperty("width", "100%", "important");
      firstParent.style.setProperty("max-width", "100%", "important");
      firstParent.style.setProperty("box-sizing", "border-box", "important");
    }
    // <a> 各カードを均等幅で広げる。2 〜 3 カードの想定。
    const n = anchors.length;
    // 列数: モバイル幅では 2 列、それ以上では n を保持。
    const cols = insWidth < 480 ? Math.min(2, n) : Math.min(3, n);
    const basis = `calc((100% - ${(cols - 1) * 6}px) / ${cols})`;
    for (const a of Array.from(anchors)) {
      a.style.setProperty("flex", `1 1 ${basis}`, "important");
      a.style.setProperty("max-width", basis, "important");
      a.style.setProperty("min-width", "0", "important");
      a.style.setProperty("box-sizing", "border-box", "important");
    }
  }
}

function AdIns({
  cfg,
  servedThisGenRef,
  hasEnteredViewportRef,
  onContent,
  onEmpty,
  onBecameVisibleAgain,
}: {
  cfg: (typeof AD_ZONES)[AdZoneKey];
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

    const tryServeOnce = () => {
      if (servedThisGenRef.current) return;
      servedThisGenRef.current = true;
      serveAd(cfg.provider);
    };

    // Recommendation Widget の固定幅インライン style を剥がして親幅まで広げる。
    // 短時間 (NORMALIZE_DURATION_MS) のあいだ widget が DOM を更新するたびに
    // 再正規化し、widget の描画が落ち着いたら observer を切る。
    // banner 系 (固定サイズ 300x250 等) は意図的にサイズ固定なので適用しない。
    const isFlexibleWidget =
      cfg.insClass === "eas6a97888e20" && cfg.reservedWidth == null;
    const NORMALIZE_DURATION_MS = 6000;
    let normalizeObs: MutationObserver | null = null;
    let normalizeStopTimer: number | null = null;
    let normalizeScheduled = false;
    const runNormalize = () => {
      // 自分自身の style 書き込みで MutationObserver を再発火させて
      // 無限ループに陥らないよう、書き込み中だけ observer を一旦切る。
      normalizeObs?.disconnect();
      try {
        normalizeAdContent(el);
      } finally {
        if (!cancelled && normalizeObs) {
          normalizeObs.observe(el, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["style", "width"],
          });
        }
      }
    };
    const scheduleNormalize = () => {
      if (!isFlexibleWidget) return;
      if (normalizeScheduled) return;
      normalizeScheduled = true;
      requestAnimationFrame(() => {
        normalizeScheduled = false;
        if (cancelled) return;
        runNormalize();
      });
    };
    const startNormalize = () => {
      if (!isFlexibleWidget) return;
      if (normalizeObs) return;
      normalizeObs = new MutationObserver(() => {
        if (cancelled) return;
        scheduleNormalize();
      });
      // 初回正規化 (runNormalize の finally 内で observer の attach も行う)。
      runNormalize();
      normalizeStopTimer = window.setTimeout(() => {
        normalizeObs?.disconnect();
        normalizeObs = null;
      }, NORMALIZE_DURATION_MS);
    };

    const mo = new MutationObserver(() => {
      if (cancelled) return;
      if (!contentSeen && insHasAd()) {
        contentSeen = true;
        onContent();
        mo.disconnect();
        startNormalize();
      }
    });
    mo.observe(el, { childList: true, subtree: true });

    let serveStarted = false;
    let collapseTimer: number | null = null;
    let retryTimer: number | null = null;

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
          onEmpty();
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
      startNormalize();
    }

    return () => {
      cancelled = true;
      mo.disconnect();
      io.disconnect();
      if (retryTimer != null) window.clearTimeout(retryTimer);
      if (collapseTimer != null) window.clearTimeout(collapseTimer);
      if (normalizeObs) normalizeObs.disconnect();
      if (normalizeStopTimer != null) window.clearTimeout(normalizeStopTimer);
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
