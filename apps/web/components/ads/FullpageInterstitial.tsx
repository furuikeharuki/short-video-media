"use client";

import { useEffect, useRef } from "react";
import { AD_ZONES, isAdZoneEnabled } from "@/lib/ads/config";
import { serveAd } from "./AdScriptLoader";

const SESSION_KEY = "ads_fullpage_interstitial_served";

/**
 * Mobile Fullpage Interstitial 用のクライアントコンポーネント。
 *
 * - `NEXT_PUBLIC_AD_FULLPAGE_INTERSTITIAL_ENABLED=true` (かつ全体スイッチ ON) のときだけ動く。
 * - UX を壊さないよう、1 セッションにつき 1 回までしか発火しない (sessionStorage で制御)。
 * - mount 時点で 1 回だけ provider script をロードし、`AdProvider.push({serve:{}})` を呼ぶ。
 *   実際の interstitial 表示タイミングは ExoClick 側 (pemsrv) が制御する。
 *
 * "後で A/B テスト用" なのでデフォルト OFF。コンポーネントの存在自体は副作用を持たず、
 * env が false のときは何も描画 / 実行しない。
 */
export default function FullpageInterstitial() {
  const firedRef = useRef(false);
  const cfg = AD_ZONES.fullpageInterstitial;
  const enabled = isAdZoneEnabled("fullpageInterstitial");

  useEffect(() => {
    if (!enabled) return;
    if (firedRef.current) return;
    try {
      if (typeof window !== "undefined" && window.sessionStorage) {
        if (sessionStorage.getItem(SESSION_KEY) === "1") return;
        sessionStorage.setItem(SESSION_KEY, "1");
      }
    } catch {
      /* ignore */
    }
    firedRef.current = true;
    void serveAd(cfg.provider);
  }, [enabled, cfg.provider]);

  if (!enabled) return null;

  return (
    <ins
      className={cfg.insClass}
      data-zoneid={cfg.zoneId}
      style={{ display: "none" }}
    />
  );
}
