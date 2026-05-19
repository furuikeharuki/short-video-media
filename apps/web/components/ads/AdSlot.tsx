"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { AD_ZONES, isAdZoneEnabled, type AdZoneKey } from "@/lib/ads/config";
import { serveAd } from "./AdScriptLoader";

type Props = {
  zone: AdZoneKey;
  /** ラッパーに付ける className (レイアウト調整用)。 */
  className?: string;
  /** ラッパーに付ける style (レイアウト微調整用)。 */
  style?: React.CSSProperties;
  /** ラベル文言を出す場合の文字列。デフォルト「広告」。null で非表示。 */
  label?: string | null;
};

/**
 * ExoClick 広告枠を 1 つ描画するクライアントコンポーネント。
 *
 * 公式タグ:
 *   <ins class="..." data-zoneid="..."></ins>
 *   <script>(AdProvider=window.AdProvider||[]).push({serve:{}})</script>
 *
 * 公式タグ準拠で <ins> 直後に同期 push する。
 * - StrictMode の二重実行や、同 ins が既に iframe を持つケースでは push しない。
 * - クライアント遷移 / ブラウザバック / bfcache 復帰時に空 ins が残るケースでも
 *   再 serve できるよう、pathname+searchParams 由来の key を ins ラッパーに当て、
 *   pageshow / visibilitychange で空 ins を再 serve する。
 * - 内容が来るまで黒い予約枠だけが見える状態を避けるため、wrapper の minHeight は
 *   コンテンツが入ったあとに付与する (空のときはレイアウト上 0 高さで畳む)。
 */
export default function AdSlot({
  zone,
  className,
  style,
  label = "広告",
}: Props) {
  const cfg = AD_ZONES[zone];
  const pathname = usePathname();
  const insRef = useRef<HTMLModElement | null>(null);
  const servedRef = useRef(false);
  const [hasContent, setHasContent] = useState(false);

  // pathname の変化を mount key として渡す。
  // (戻る/進む で同じ URL に戻った時も React は同じインスタンスを使うので、
  //  ins が空のままなら useEffect の中で再 serve させる。)
  const navKey = pathname ?? "";

  useEffect(() => {
    if (!cfg.enabled) return;
    const el = insRef.current;
    if (!el) return;

    let cancelled = false;

    const insHasAd = (): boolean =>
      !!el.querySelector("iframe, img, ins > *");

    const tryServe = () => {
      if (cancelled) return;
      if (insHasAd()) {
        setHasContent(true);
        return;
      }
      // 空 ins なら serve を再キックする。
      // ad-provider.js は serve:{} を push されると DOM 上の空 <ins data-zoneid> を
      // 走査して埋めにいくので、複数回呼ばれても二重に iframe が増えることはない。
      serveAd(cfg.provider);
    };

    // 既に iframe が入っている (HMR / 再 mount) なら状態反映だけして抜ける。
    if (insHasAd()) {
      setHasContent(true);
      servedRef.current = true;
    } else {
      // 同一 mount 内の二重 serve を防ぐ (StrictMode 対策)。
      if (!servedRef.current) {
        servedRef.current = true;
        serveAd(cfg.provider);
      } else {
        // 別 mount (例: ブラウザバック後の再 mount) で ins が空のまま残っている。
        tryServe();
      }
    }

    // 広告挿入を観測して、ラベル等の見せ方を調整する。
    const observer = new MutationObserver(() => {
      if (insHasAd()) {
        setHasContent(true);
        observer.disconnect();
      }
    });
    observer.observe(el, { childList: true, subtree: true });

    // 一定時間 (約 5 秒) 経っても何も入らなければ諦めて監視解除。
    const giveUpTimer = window.setTimeout(() => {
      observer.disconnect();
    }, 5000);

    // 短時間 ins が空のままなら 1 度だけ再 serve を試す
    // (ad-provider.js のロードが遅れた場合のレース対策)。
    const retryTimer = window.setTimeout(() => {
      if (!insHasAd()) tryServe();
    }, 600);

    // 戻る (popstate) / bfcache 復帰 (pageshow.persisted) / タブ復帰
    // (visibilitychange) のときに ins が空なら再 serve する。
    const onPageShow = (e: PageTransitionEvent) => {
      if (!insHasAd()) {
        // bfcache 復帰時もそうでない時も、空ならとにかく serve を呼ぶ。
        // persisted は念のため参照しているが、判断には使わない。
        void e.persisted;
        tryServe();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible" && !insHasAd()) {
        tryServe();
      }
    };
    const onPopState = () => {
      if (!insHasAd()) tryServe();
    };
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("popstate", onPopState);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      observer.disconnect();
      window.clearTimeout(giveUpTimer);
      window.clearTimeout(retryTimer);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("popstate", onPopState);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // navKey を依存に入れることでクライアント遷移時にも再評価される。
  }, [cfg.enabled, cfg.provider, navKey]);

  if (!isAdZoneEnabled(zone)) return null;

  // 中身が入るまで wrapper を 0 高さで畳むことで、黒い空枠だけが見える状態を避ける。
  // 入ったら reservedHeight を付けて CLS を抑える。背景は常に透明にする。
  const wrapperStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    boxSizing: "border-box",
    background: "transparent",
    ...(hasContent && cfg.reservedHeight != null
      ? { minHeight: `${cfg.reservedHeight}px` }
      : {}),
    ...style,
  };

  // ins 自身も最低サイズは「内容が入ったら」確保する。
  // 空のときに 300x250 の黒矩形が見える事故を防ぐ。
  const insStyle: React.CSSProperties = {
    display: "inline-block",
    background: "transparent",
    ...(hasContent && cfg.reservedWidth != null
      ? { width: `${cfg.reservedWidth}px` }
      : {}),
    ...(hasContent && cfg.reservedHeight != null
      ? { minHeight: `${cfg.reservedHeight}px` }
      : {}),
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
      <ins
        ref={insRef as React.RefObject<HTMLModElement>}
        className={cfg.insClass}
        data-zoneid={cfg.zoneId}
        style={insStyle}
      />
    </aside>
  );
}
