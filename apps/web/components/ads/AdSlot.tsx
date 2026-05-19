"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AD_ZONES, isAdZoneEnabled, type AdZoneKey } from "@/lib/ads/config";
import { resetAndServeAd, serveAd } from "./AdScriptLoader";

type Props = {
  zone: AdZoneKey;
  className?: string;
  style?: React.CSSProperties;
  label?: string | null;
};

/**
 * sessionStorage に広告の「入り済み」状態を保存/読み込みするキー。
 *
 * Next.js App Router では force-dynamic の Server Component への戻りなどで
 * コンポーネントがアンマウント→再マウントされる。React state はリセットされるため、
 * sessionStorage で「その枠にかつて広告が入ったことがある」を記憶する。
 *
 * セッション内のみ有効。タブを閉じたりリロードするとリセットされる (sessionStorage の仕様通り)。
 */
function makeStorageKey(zone: AdZoneKey) {
  return `ad_slot_filled_${zone}`;
}

function readWasFilled(zone: AdZoneKey): boolean {
  try {
    return sessionStorage.getItem(makeStorageKey(zone)) === "1";
  } catch {
    return false;
  }
}

function writeWasFilled(zone: AdZoneKey): void {
  try {
    sessionStorage.setItem(makeStorageKey(zone), "1");
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
 *    されてしまう。hasContent=false に戻るため bump 判定がトリガーされ広告が
 *    消える。sessionStorage で復元することで「前回已表示」を記憶する。
 */
export default function AdSlot({
  zone,
  className,
  style,
  label = "広告",
}: Props) {
  const cfg = AD_ZONES[zone];

  // 内側 <ins> を作り直すための世代 key。
  // 戻る/復帰/再可視化時に bump して新しい <ins> を mount する。
  const [insKey, setInsKey] = useState(0);

  // 現世代の <ins> に creative が入ったか。
  // 初期値: sessionStorage から復元する (Server Component 再レンダリング後の再マウント対策)。
  // SSR 時は sessionStorage にアクセスできないため false 始まりにし、
  // useLayoutEffect でクライアント側初回レンダリング後に復元する。
  const [hasContent, setHasContent] = useState(false);

  // 現世代が no-fill で諦め済みか (display:none にはしない、最小高さで残す)。
  const [emptyGen, setEmptyGen] = useState(false);

  // hasContent の ref 版。useEffect クロージャーから最新値を安全に読むために使う。
  // state だけだと登録時点の値がクロージャーに閉じ込められ、広告表示後も false のまま読まれて
  // 誤 bump が発生する。
  const hasContentRef = useRef(false);

  // 直近の世代 bump 時刻 (クールダウン用)。
  const lastBumpAtRef = useRef(0);
  // 現世代の <ins> が既に serve 試行されたか (StrictMode 二重実行対策)。
  const servedThisGenRef = useRef(false);

  // bump 要求中フラグ。短時間に複数イベントが来ても 1 回だけ bump する。
  const bumpScheduledRef = useRef(false);

  // 既に viewport に入って 1 度でも serve したか。初回 serve は IntersectionObserver
  // 経由で発火させ、それ以降の bump はイベント駆動。
  const hasEnteredViewportRef = useRef(false);

  const enabled = cfg.enabled;

  // --- 復帰処理: クライアント初回レンダリング時に sessionStorage から状態を復元 ---
  //
  // useLayoutEffect でやる理由: paint 前に state を確定することで、
  // 「広告スペースが一瞬ゼロ高さで表示される」 CLS を抑制する。
  // SSR では動かないので typeof window ガードは不要だが念のため残す。
  useLayoutEffect(() => {
    if (!enabled) return;
    const wasFilled = readWasFilled(zone);
    if (wasFilled) {
      // 前回広告表示済み。hasContent=true に戻して
      // 予約高さのコンテナを維持し、requestBump の誤発火を抑制する。
      hasContentRef.current = true;
      setHasContent(true);
      // 再マウント直後は <ins> がまだフレッシュなので、
      // viewport 進入待ちから素直に serve する。
      // provider リセットはしない: 他の AdSlot が平行して再マウントしており、
      // ここで resetAndServeAd すると AdScriptLoader のクールダウンで
      // "only serveAd" にダウングレードされる場合があるため。
      // IntersectionObserver 内で serveAd を呼ぶのでここは何もしない。
    }
  // zone/enabled 変化時に 1 度だけ実行。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone, enabled]);

  /**
   * 世代 bump を要求する。
   * - creative が既に入っているなら何もしない (張り替える必要がない)
   * - 直近 2 秒以内に bump 済みなら何もしない
   * - それ以外: 次フレームで insKey++ + emptyGen=false に戻す
   *
   * `withProviderReset=true` の場合は ad-provider.js を一度捨てて再注入する。
   * ※ hasContent は ref 経由で読む。state をクロージャーで閉じ込めると
   *   広告表示後も古い false を参照して誤 bump してしまう。
   */
  const requestBump = (withProviderReset: boolean) => {
    if (!enabled) return;
    if (hasContentRef.current) return;  // ref で最新値を参照
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

  // ナビゲーション復帰系イベント。ホーム→/feed→ホームで戻ったときの拾い直しが目的。
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
          writeWasFilled(zone);        // ← sessionStorage に永続化
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
 * 単一の <ins data-zoneid> を render するだけのサブコンポーネント。
 */
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
