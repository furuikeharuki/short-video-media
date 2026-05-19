"use client";

import { useEffect, useRef } from "react";

const AD_PROVIDER_SRC = "https://a.magsrv.com/ad-provider.js";
const DEFAULT_ZONE_ID = "5929876";
const AD_CLASS = "eas6a97888e2";

const NATURAL_W = 900;
const NATURAL_H = 250;
const MAX_VISIBLE_W = 320;
const SIDE_PADDING = 24;

/** Reserved height (in px) for the scaled banner, exported for layout offsets. */
export const EXOCLICK_BANNER_HEIGHT = Math.round(
  (MAX_VISIBLE_W * NATURAL_H) / NATURAL_W,
);

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
  /** Reserved height to limit CLS. Defaults to the scaled banner height. */
  minHeight?: number;
  className?: string;
}

/**
 * ExoClick banner ad slot (900x250 zone, visually scaled down).
 *
 * The ExoClick creative ships at its natural 900x250 size; we render it at that
 * size inside a hidden viewport and apply transform: scale so it fits within
 * ~320px width / ~89px height on the feed without distortion.
 *
 * Renders nothing when NEXT_PUBLIC_ADS_ENABLED is not "true".
 */
export default function ExoClickBanner({
  zoneId,
  minHeight,
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

  const reservedHeight =
    typeof minHeight === "number" ? minHeight : EXOCLICK_BANNER_HEIGHT;

  return (
    <div
      className={className ? `exoclick-banner ${className}` : "exoclick-banner"}
      style={{ minHeight: reservedHeight, height: reservedHeight }}
      aria-label="広告"
    >
      <div className="exoclick-banner__viewport">
        <div className="exoclick-banner__scaler">
          <ins
            ref={insRef}
            className={AD_CLASS}
            data-zoneid={resolvedZoneId}
          />
        </div>
      </div>
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
  .exoclick-banner__viewport {
    position: relative;
    width: min(100vw - ${SIDE_PADDING}px, ${MAX_VISIBLE_W}px);
    aspect-ratio: ${NATURAL_W} / ${NATURAL_H};
    max-height: ${EXOCLICK_BANNER_HEIGHT}px;
    overflow: hidden;
  }
  .exoclick-banner__scaler {
    position: absolute;
    top: 0;
    left: 0;
    width: ${NATURAL_W}px;
    height: ${NATURAL_H}px;
    transform-origin: top left;
    transform: scale(calc(min(100vw - ${SIDE_PADDING}px, ${MAX_VISIBLE_W}px) / ${NATURAL_W}));
  }
  .exoclick-banner__scaler > ins {
    display: block;
    width: ${NATURAL_W}px;
    height: ${NATURAL_H}px;
  }
`;
