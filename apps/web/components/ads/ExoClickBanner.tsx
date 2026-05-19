"use client";

import { useEffect, useRef } from "react";

const AD_PROVIDER_SRC = "https://a.magsrv.com/ad-provider.js";
const DEFAULT_ZONE_ID = "5929876";
const AD_CLASS = "eas6a97888e2";

type AdProviderQueue = Array<Record<string, unknown>>;

declare global {
  interface Window {
    AdProvider?: AdProviderQueue;
  }
}

function ensureAdProviderScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(
    `script[src="${AD_PROVIDER_SRC}"]`,
  );
  if (existing) {
    if (existing.dataset.loaded === "true") return Promise.resolve();
    return new Promise((resolve) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => resolve(), { once: true });
    });
  }
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.async = true;
    s.type = "application/javascript";
    s.src = AD_PROVIDER_SRC;
    s.addEventListener(
      "load",
      () => {
        s.dataset.loaded = "true";
        resolve();
      },
      { once: true },
    );
    s.addEventListener("error", () => resolve(), { once: true });
    document.head.appendChild(s);
  });
}

export interface ExoClickBannerProps {
  /** ExoClick zone id. Falls back to NEXT_PUBLIC_EXOCLICK_BANNER_ZONE_ID, then "5929876". */
  zoneId?: string;
  /** Reserved height to limit CLS. */
  minHeight?: number;
  className?: string;
}

/**
 * ExoClick banner ad slot.
 *
 * Renders nothing when NEXT_PUBLIC_ADS_ENABLED is not "true".
 * The provider script is loaded once per page even if multiple slots mount.
 */
export default function ExoClickBanner({
  zoneId,
  minHeight = 100,
  className,
}: ExoClickBannerProps) {
  const adsEnabled = process.env.NEXT_PUBLIC_ADS_ENABLED === "true";
  const resolvedZoneId =
    zoneId ??
    process.env.NEXT_PUBLIC_EXOCLICK_BANNER_ZONE_ID ??
    DEFAULT_ZONE_ID;
  const insRef = useRef<HTMLModElement | null>(null);

  useEffect(() => {
    if (!adsEnabled) return;
    let cancelled = false;
    void ensureAdProviderScript().then(() => {
      if (cancelled) return;
      try {
        window.AdProvider = window.AdProvider || [];
        window.AdProvider.push({ serve: {} });
      } catch {
        /* ignore — ad failure must not break the feed */
      }
    });
    return () => {
      cancelled = true;
    };
  }, [adsEnabled, resolvedZoneId]);

  if (!adsEnabled) return null;

  return (
    <div
      className={className ? `exoclick-banner ${className}` : "exoclick-banner"}
      style={{ minHeight }}
      aria-label="広告"
    >
      <ins
        ref={insRef}
        className={AD_CLASS}
        data-zoneid={resolvedZoneId}
      />
      <style>{bannerStyle}</style>
    </div>
  );
}

const bannerStyle = `
  .exoclick-banner {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    background: #000;
    overflow: hidden;
  }
  .exoclick-banner > ins {
    display: block;
    max-width: 100%;
  }
`;
