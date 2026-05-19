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

/**
 * sessionStorage に広告の「入り済み」状態を保存/読み込みするキー。
 * context を含めることで、同一ゾーンをページとモーダルで使い分けても衝突しない。
 */
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
 * ExoClick 広告枠を 1 つ描画するクライアントコンポーネント。
 *
 * 公式タグ:
 *   <ins class="..." data-zoneid="..."></ins>
 *   <script>(AdProvider=window.AdProvider||[]).push({serve:{}})</script>
 *
 * 設計ポイント:
 *
 * 1. <ins> は内側の <AdIns> に key を当てて分離する。
 *    再生成 (key bump) すると React は <ins> の DOM を作り直すため、
 *    ad-provider.js は「新しい未処理 <ins>」として再 serve できる。
 *
 * 2. **viewport に入ってから serve する**。
 *    オフスクリーンの枠を即 serve すると、ExoClick は viewport 外の枠を
 *    no-fill 扱いにしやすく、結果として「ホームをスクロールしているうちに
 *    広告がだんだん消える」症状を引き起こす。IntersectionObserver で
 *    最初に画面内に入ったタイミングを待ってから初回 serve する。
 *
 * 3. **空のまま終わった枠も DOM 上は残し、display:none で完全に消さない**。
 *    一度畳むと戻れなくなり「何回か表示しているうちに消える」症状になる。
 *    no-fill 判定後は枠を最小高さで保持し、次に viewport に再進入したり
 *    タブが復帰した時に key を bump してもう一度 serve を試す。
 *
 * 4. **複数枠が同居するページで provider を巻き添えで殺さない**。
 *    ad-provider.js のリセットは「ホーム復帰直後の最初の 1 回」のみ。
 *    クールダウンを AdScriptLoader 側に持たせ、複数 AdSlot から同時に
 *    要求が来ても 1 回しか効かないようにしてある。
 *
 * 5. ナビゲーション復帰 (popstate / pageshow / visibilitychange) を検知して、
 *    creative が入っていない (またはそもそも今までフィルされなかった) 枠を
 *    key bump で作り直し、合わせて provider を 1 度だけリセット要求する。
 *
 * 6. **広告表示済み状態を sessionStorage で永続化**。
 *    Next.js App Router でホーム (force-dynamic Server Component) に戻ると
 *    コンポーネント自体がアンマウント→再マウントされ、React state がリセット
 *    されてしまう。sessionStorage で復元することで「前回既表示」を記憶する。
 *
 * 7. **context prop でゾーン×コンテキストごとにキーを分離**。
 *    同一ゾーン (native 等) を詳細ページとモーダルで同時に使う場合、
 *    sessionStorage キーが衝突して状態が混在する。context="modal" / "page" で
 *    それぞれ独立したキーを持つ。
 *
 * 8. **resetOnMount=true でモーダル open 時に provider をリセット**。
 *    Parallel Routes のモーダルは背後のページ DOM が生きたまま <ins> が追加される。
 *    ad-provider.js の初期スキャンは既に終わっているため、新しい <ins> を
 *    取りこぼすことがある。resetOnMount=true を渡すことで mount 時に
 *    resetAndServeAd を 1 度だけ呼び、未処理 <ins> を拾い直す。
 */
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

  // --- 復帰処理: クライアント初回レンダリング時に sessionStorage から状態を復元 ---
  useLayoutEffect(() => {
    if (!enabled) return;
    const wasFilled = readWasFilled(zone, context);
    if (wasFilled) {
      hasContentRef.current = true;
      setHasContent(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone, context, enabled]);

  // --- resetOnMount: モーダル等で mount 直後に provider をリセット ---
  // IntersectionObserver が viewport 進入を検知する前でも、
  // provider を再スキャンさせることで新 <ins> を確実に拾わせる。
  useEffect(() => {
    if (!enabled) return;
    if (!resetOnMount) return;
    // 少しだけ遅延して <ins> が DOM に描画されてから呼ぶ
    const t = window.setTimeout(() => {
      resetAndServeAd(cfg.provider);
    }, 100);
    return () => window.clearTimeout(t);
  // mount 時のみ。enabled/resetOnMount が変わることは想定しない。
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
