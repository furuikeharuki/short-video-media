"use client";

import { useEffect, useRef, useState } from "react";
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
 * 上のパターン (ins を DOM に出した直後に同期 push) を踏襲し、script ロードを待たない。
 * StrictMode の二重実行や、同 ins が既に iframe を持つケースでは push しない。
 */
export default function AdSlot({
  zone,
  className,
  style,
  label = "広告",
}: Props) {
  const cfg = AD_ZONES[zone];
  const insRef = useRef<HTMLModElement | null>(null);
  const servedRef = useRef(false);
  const [hasContent, setHasContent] = useState(false);

  useEffect(() => {
    if (!cfg.enabled) return;
    const el = insRef.current;
    if (!el) return;

    // 既に iframe が入っている (HMR / 再 mount) ならスキップ。
    if (el.querySelector("iframe")) {
      setHasContent(true);
      return;
    }

    // 同一 mount 内で二重 serve しないようガード (StrictMode 対策)。
    if (servedRef.current) return;
    servedRef.current = true;

    serveAd(cfg.provider);

    // 広告挿入を観測して、ラベル等の見せ方を調整する。
    const observer = new MutationObserver(() => {
      if (el.querySelector("iframe, ins > *, img")) {
        setHasContent(true);
        observer.disconnect();
      }
    });
    observer.observe(el, { childList: true, subtree: true });

    // 一定時間 (約 5 秒) 経っても何も入らなければ諦めて監視解除。
    const timer = window.setTimeout(() => {
      observer.disconnect();
    }, 5000);

    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [cfg.enabled, cfg.provider]);

  if (!isAdZoneEnabled(zone)) return null;

  const wrapperStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    boxSizing: "border-box",
    ...(cfg.reservedHeight != null ? { minHeight: `${cfg.reservedHeight}px` } : {}),
    ...style,
  };

  const insStyle: React.CSSProperties = {
    display: "inline-block",
    ...(cfg.reservedWidth != null ? { width: `${cfg.reservedWidth}px` } : {}),
    ...(cfg.reservedHeight != null ? { minHeight: `${cfg.reservedHeight}px` } : {}),
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
