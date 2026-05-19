/**
 * ExoClick 広告の設定。
 *
 * 各 zone は個別に環境変数で ON/OFF できる。
 * 全体スイッチ `NEXT_PUBLIC_ADS_ENABLED` も用意し、これが false なら
 * 個別 ON でも一切表示しない。
 */

function parseBool(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function parseIntOr(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const masterEnabled = parseBool(process.env.NEXT_PUBLIC_ADS_ENABLED);

export type AdZoneKey =
  | "native"
  | "feedNative"
  | "mobileBanner300x250"
  | "mobileBanner300x100"
  | "fullpageInterstitial";

export type AdZoneConfig = {
  /** ExoClick の zoneid。 */
  zoneId: string;
  /** ad provider script の origin (magsrv/pemsrv)。 */
  provider: "magsrv" | "pemsrv";
  /** `<ins class="...">` の CSS クラス名。 */
  insClass: string;
  /** 個別 ON/OFF (全体スイッチと AND される)。 */
  enabled: boolean;
  /** 予約高さ (CLS 抑止)。null なら自動。 */
  reservedHeight: number | null;
  /** 予約幅 (任意)。 */
  reservedWidth: number | null;
};

export const AD_ZONES: Record<AdZoneKey, AdZoneConfig> = {
  /** 詳細ページ・女優ページ末尾に置く native 広告 */
  native: {
    zoneId: process.env.NEXT_PUBLIC_EXOCLICK_NATIVE_ZONE_ID ?? "5929928",
    provider: "magsrv",
    insClass: "eas6a97888e20",
    enabled:
      masterEnabled && parseBool(process.env.NEXT_PUBLIC_AD_NATIVE_ENABLED),
    reservedHeight: 260,
    reservedWidth: null,
  },
  /**
   * 検索・ジャンル一覧のグリッド内に AD_FEED_INTERVAL 件ごとに差し込む native 広告。
   * zone ID: 5930078 (フィード内ネイティブ専用)
   */
  feedNative: {
    zoneId: process.env.NEXT_PUBLIC_EXOCLICK_FEED_NATIVE_ZONE_ID ?? "5930078",
    provider: "magsrv",
    insClass: "eas6a97888e20",
    enabled:
      masterEnabled && parseBool(process.env.NEXT_PUBLIC_AD_FEED_NATIVE_ENABLED),
    reservedHeight: 260,
    reservedWidth: null,
  },
  mobileBanner300x250: {
    zoneId:
      process.env.NEXT_PUBLIC_EXOCLICK_MOBILE_BANNER_300X250_ZONE_ID ??
      "5929910",
    provider: "magsrv",
    insClass: "eas6a97888e10",
    enabled:
      masterEnabled &&
      parseBool(process.env.NEXT_PUBLIC_AD_MOBILE_BANNER_300X250_ENABLED),
    reservedHeight: 250,
    reservedWidth: 300,
  },
  mobileBanner300x100: {
    zoneId:
      process.env.NEXT_PUBLIC_EXOCLICK_MOBILE_BANNER_300X100_ZONE_ID ??
      "5929930",
    provider: "magsrv",
    insClass: "eas6a97888e10",
    enabled:
      masterEnabled &&
      parseBool(process.env.NEXT_PUBLIC_AD_MOBILE_BANNER_300X100_ENABLED),
    reservedHeight: 100,
    reservedWidth: 300,
  },
  fullpageInterstitial: {
    zoneId:
      process.env.NEXT_PUBLIC_EXOCLICK_FULLPAGE_INTERSTITIAL_ZONE_ID ??
      "5929932",
    provider: "pemsrv",
    insClass: "eas6a97888e33",
    enabled:
      masterEnabled &&
      parseBool(process.env.NEXT_PUBLIC_AD_FULLPAGE_INTERSTITIAL_ENABLED),
    reservedHeight: null,
    reservedWidth: null,
  },
};

/** 広告全体スイッチ。false なら個別 enabled も実質無効。 */
export const ADS_MASTER_ENABLED = masterEnabled;

/** 任意の zone が有効か。 */
export function isAdZoneEnabled(key: AdZoneKey): boolean {
  return AD_ZONES[key].enabled;
}

/**
 * フィード内広告の挿入間隔 (件)。
 * 環境変数 NEXT_PUBLIC_AD_FEED_INTERVAL で上書き可。
 * 0 以下なら挿入しない。
 */
export const AD_FEED_INTERVAL = parseIntOr(
  process.env.NEXT_PUBLIC_AD_FEED_INTERVAL,
  10,
);

/** 一覧 / 検索結果に広告を挿入する間隔 (件)。0 以下なら挿入しない。 */
export const AD_LIST_INTERVAL = parseIntOr(
  process.env.NEXT_PUBLIC_AD_LIST_INTERVAL,
  6,
);
