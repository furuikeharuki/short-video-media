"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AD_ZONES, isAdZoneEnabled, type AdZoneKey } from "@/lib/ads/config";
import { resetAndServeAd, serveAd } from "./AdScriptLoader";

type Props = {
  zone: AdZoneKey;
  className?: string;
  style?: React.CSSProperties;
  label?: string | null;
  /**
   * 同一ゾーンが複数コンテキスト (ページ / モーダル) で使われるとき、
   * sessionStorage キーを分離するための識別子。
   * 例: <AdSlot zone="native" context="modal" />
   * デフォルトは "page"。
   */
  context?: string;
  /**
   * モーダルなど「mount された瞬間に provider をリセットして新しい <ins> を
   * 確実に拾わせたい」ときに true にする。
   * true の場合、mount 時に resetAndServeAd を 1 度だけ呼ぶ。
   */
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
  resetOnMount = false,
}: Props) {
  const cfg = AD_ZONES[zone];

  const [insKey, setInsKey] = useState(0);
  const [hasContent, setHasContent] = useState(false);
  const [emptyGen, setEmptyGen] = useState(false);

  const hasContentRef = useRef(false);
  const lastBumpAtRef = useRef(0);
  const servedThisGenRef = useRef(false);
  const bumpScheduledRef = useRef(false);
  const hasEnteredViewportRef = useRef(false);

  const enabled = cfg.enabled;

  /**
   * クライアント初回レンダリング時の初期化。
   *
   * ポイント: sessionStorage に "1" がある = 「かつてこのセッション内で広告が入った」
   * という事実だけを意味する。これを hasContent=true に映するのはあくまで「予約高さを持つコンテナを
   * CLS させずに維持する」ため。実際に creative が入っているかは別問題。
   *
   * この mount 時に <ins> は必ず空 (DOM 初期化直後) なので、
   * resetAndServeAd を呼んで provider に再スキャンさせる必要がある。
   * ただし複数 AdSlot が並行する場合は reset を 1 回に抑えたいため、
   * 別の useEffect (下記) で処理し、LayoutEffect は高さの復元のみ担う。
   */
  useLayoutEffect(() => {
    if (!enabled) return;
    const wasFilled = readWasFilled(zone, context);
    if (wasFilled) {
      // hasContent=true にはするが、hasContentRef は false のままにする。
      // → requestBump が「前回入ったけど今回はまだ空」を正しく検知できる。
      setHasContent(true);
      // hasContentRef.current は false のまま: viewport 進入時に bump させる
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone, context, enabled]);

  /**
   * mount 直後に creative の実在を確認し、入っていなければ resetAndServeAd を呼ぶ。
   *
   * 「wasFilled が記録されている = creative が必ず入っている」わけではない。
   * ナビゲーション復帰の場合、Next.js App Router は force-dynamic ページを再レンダリングし、
   * AdSlot がアンマウント→再マウントされる。<ins> は常に空の DOM から始まる。
   * このタイミングで provider をリセットしないと、ExoClick は新しい <ins> を拾いたくれない。
   *
   * 個別の 「reset」 と 「resetOnMount」 の違い:
   *   - resetOnMount: モーダル用。常に mount 時に reset。
   *   - ここのロジック: 通常ページ用。wasFilled かつ creative が空のときにのみ reset。
   */
  useEffect(() => {
    if (!enabled) return;

    if (resetOnMount) {
      // モーダル: mount 時に必ず reset
      const t = window.setTimeout(() => {
        resetAndServeAd(cfg.provider);
      }, 100);
      return () => window.clearTimeout(t);
    }

    // 通常ページ: wasFilled が記録されている場合は、creative が本当に入っているか確認する。
    // 确認方法: 少し待ってから <ins> 内に creative DOM があるかをチェック。
    // あれば hasContentRef=true にして bump を抑制、なければ resetAndServeAd で拾い直す。
    const wasFilled = readWasFilled(zone, context);
    if (!wasFilled) return;

    const t = window.setTimeout(() => {
      // <ins> の子要素を確認 (IntersectionObserver が発火する前の時間帯)
      const insEl = document.querySelector(
        `.ad-slot-${zone} ins[data-zoneid]`
      );
      const hasCreative = !!insEl?.querySelector(
        "iframe, img, video, a, picture, canvas"
      );
      if (hasCreative) {
        // creative あり: hasContentRef=true にして bump を抑制
        hasContentRef.current = true;
      } else {
        // creative なし: provider をリセットして拾い直す
        resetAndServeAd(cfg.provider);
      }
    }, 300);
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
    const onPageShow = (e: PageTransitionEvent) => {
      void e.persisted;
      requestBump(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") requestBump(false);
    };
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
    boxSizing: "border-box",
    background: "transparent",
    minHeight:
      hasContent && cfg.reservedHeight != null
        ? `${cfg.reservedHeight}px`
        : emptyGen
          ? "1px"
          : "1px",
    ...style,
  };

  return (
    <aside
      className={`ad-slot ad-slot-${zone}${className ? ` ${className}` : ""}`}
      style={wrapperStyle}
      aria-label={label ?? undefined}
      role="complementary"
    >
      {label && hasContent && (
        <span
          style={{
            fontSize: 10,
            color: "rgba(255,255,255,0.35)",
            letterSpacing: "0.08em",
            marginBottom: 4,
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

  const insStyle: React.CSSProperties = {
    display: "inline-block",
    background: "transparent",
    ...(cfg.reservedWidth != null ? { width: `${cfg.reservedWidth}px` } : {}),
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
