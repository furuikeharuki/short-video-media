"use client";

import { useEffect, useRef } from "react";
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
 * - `enabled` が false の zone は何も描画しない (DOM ごと出さない)。
 * - mount 後に provider script のロードを保証し、`AdProvider.push({serve:{}})`
 *   を呼んで該当 zone を slot に詰める。
 * - CLS 抑止のため `reservedHeight` / `reservedWidth` の最小サイズを確保する。
 */
export default function AdSlot({
  zone,
  className,
  style,
  label = "広告",
}: Props) {
  const cfg = AD_ZONES[zone];
  const insRef = useRef<HTMLModElement | null>(null);

  useEffect(() => {
    if (!cfg.enabled) return;
    // 同一 ins が再 mount される / strict mode の二重実行に備えて、
    // 既に内部 iframe を持っているなら push しない。
    const el = insRef.current;
    if (el && el.querySelector("iframe")) return;
    void serveAd(cfg.provider);
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
      {label && (
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
