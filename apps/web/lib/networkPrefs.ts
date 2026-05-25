/**
 * ブラウザ環境を見て「先読みをどこまで攻めるか」を返すユーティリティ。
 *
 * 判定軸:
 *   - Save-Data ヘッダ (NetworkInformation.saveData) が ON のとき → 先読みを止める
 *   - effectiveType が "2g" / "slow-2g" のとき → 先読みを止める
 *   - effectiveType が "3g" のとき → +1 のみに抑える
 *   - Safari / iOS Safari → +1 のみ + 隠し <video> 数を絞る
 *     (モバイル Safari は同 origin あたり HTTP 同時接続が 4〜6 と少なく、
 *      隠し <video> を複数マウントすると中央 <video> の Range 取得を奪う)
 *   - Chrome / Chromium / Android Chrome → +1 と +2 の 2 枚先読み
 *
 * SSR セーフ: window が無い場合は保守的なデフォルト (Safari と同じ +1 だけ) を返す。
 */

export type PrefetchPolicy = {
  /**
   * 中央スライドの後ろに何枚先まで bytes prefetch するか。
   * 0 = 完全に止める / 1 = "次" のみ / 2 = "次" と "次の次"。
   */
  aheadCount: number;
  /**
   * 隠し <video> に渡す preload 属性。
   * - Safari は同時接続を浪費しないよう "metadata" でメタデータだけ取得 (= byte は読まない)
   * - Chrome は "auto" で先頭バッファまで取得
   */
  preload: "auto" | "metadata" | "none";
  /** デバッグ用: 判定根拠の文字列。本番には出さない。 */
  reason: string;
};

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

interface NavigatorWithConnection extends Navigator {
  connection?: NetworkInformationLike;
  mozConnection?: NetworkInformationLike;
  webkitConnection?: NetworkInformationLike;
}

/**
 * Safari / iOS Safari 判定。Chromium ベースの iOS ブラウザ (Edge for iOS 等) も
 * 内部レンダラは WebKit のため Safari と同じ制約を持つ。userAgent ベースで雑だが
 * 既存 README の対象ブラウザ範囲 (モバイル/PC の Safari + Chrome) では十分機能する。
 */
function isSafariLike(ua: string): boolean {
  // iOS / iPadOS は常に WebKit
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // macOS Safari は "Safari" を含み "Chrome"/"Chromium"/"Edg" を含まない
  if (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua)) return true;
  return false;
}

/**
 * 現在の環境に応じた prefetch ポリシーを返す。
 *
 * 注: NetworkInformation API は Safari では未対応で undefined。その場合は
 * effectiveType ガードは無効化され、Safari 判定だけで保守側にシフトする。
 */
export function getPrefetchPolicy(): PrefetchPolicy {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { aheadCount: 1, preload: "metadata", reason: "ssr" };
  }

  const nav = navigator as NavigatorWithConnection;
  const connection: NetworkInformationLike | undefined =
    nav.connection ?? nav.mozConnection ?? nav.webkitConnection;

  // Save-Data ヘッダが ON → 全てやめる
  if (connection?.saveData === true) {
    return { aheadCount: 0, preload: "none", reason: "save-data" };
  }

  const et = connection?.effectiveType;
  if (et === "2g" || et === "slow-2g") {
    return { aheadCount: 0, preload: "none", reason: `effective-type=${et}` };
  }

  const safari = isSafariLike(navigator.userAgent || "");

  if (et === "3g") {
    // 3G では Chrome でも +1 のみ。Safari は metadata で更に絞る。
    return safari
      ? { aheadCount: 1, preload: "metadata", reason: "3g+safari" }
      : { aheadCount: 1, preload: "auto", reason: "3g" };
  }

  if (safari) {
    // 4G / wifi / 未検出 でも Safari は +1 だけに留め、preload も metadata。
    // モバイル Safari の同時接続上限を中央 + 隣接 <video> に温存する。
    return { aheadCount: 1, preload: "metadata", reason: "safari" };
  }

  // Chrome / Chromium / Edge (Chromium): +1 と +2 を bytes 先読み。
  return { aheadCount: 2, preload: "auto", reason: "chromium" };
}

/**
 * 解決された mp4 URL の origin に対して動的に <link rel="preconnect"> を追加する。
 *
 * 仕様:
 *   - 1 origin 1 回のみ (Set で dedupe)。
 *   - 上限 8 origin で打ち切り (HTTP/2 接続を浪費しないため)。
 *   - DOM が無いとき (SSR) は no-op。
 *   - 既に同 href の preconnect link がある場合は何もしない。
 *
 * これにより、resolver が返した実 CDN ホスト (例: cc3001.dmm.co.jp の代替ホスト) に
 * 対しても TCP/TLS handshake を前倒しできる。byte transfer は伴わない。
 */
const preconnectedOrigins = new Set<string>();
const MAX_PRECONNECTS = 8;

export function ensurePreconnect(rawUrl: string | null | undefined): void {
  if (!rawUrl) return;
  if (typeof document === "undefined") return;
  let origin: string;
  try {
    origin = new URL(rawUrl).origin;
  } catch {
    return;
  }
  if (!origin || origin === "null") return;
  if (preconnectedOrigins.has(origin)) return;
  if (preconnectedOrigins.size >= MAX_PRECONNECTS) return;

  // 既に <link rel="preconnect" href="..."> があるならノーオペ。
  const existing = document.querySelector(
    `link[rel="preconnect"][href="${origin}"]`,
  );
  if (existing) {
    preconnectedOrigins.add(origin);
    return;
  }

  preconnectedOrigins.add(origin);

  const link = document.createElement("link");
  link.rel = "preconnect";
  link.href = origin;
  // crossOrigin を付けないと、Range リクエストの実 TCP 接続と別の接続を作ってしまう
  // ことがある (CORS 設定の有無で別接続扱いになる)。動画は anonymous で取得するため。
  link.crossOrigin = "anonymous";
  document.head.appendChild(link);

  // dns-prefetch も併用 (古いブラウザの fallback)
  const dns = document.createElement("link");
  dns.rel = "dns-prefetch";
  dns.href = origin;
  document.head.appendChild(dns);
}
