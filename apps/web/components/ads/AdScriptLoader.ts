/**
 * ExoClick の ad-provider.js を 1 度だけロードするためのユーティリティ。
 *
 * provider は 2 系統:
 *  - magsrv: native / mobile banner 用 (`https://a.magsrv.com/ad-provider.js`)
 *  - pemsrv: fullpage interstitial 用 (`https://a.pemsrv.com/ad-provider.js`)
 *
 * どちらも `window.AdProvider` という同名 (但しスクリプト的には別物) のグローバル配列を
 * 共有する設計のため、同じスクリプトの重複ロードは避ける。
 *
 * 公式タグは <ins> の直後に同期 push する設計のため、スクリプトのロード完了を待たずに
 * push する。ad-provider.js は AdProvider が配列のうちはキューを溜め、ロード後に
 * 自身の `push` 実装に差し替えて未処理 ins を走査する。
 */

declare global {
  interface Window {
    AdProvider?: Array<Record<string, unknown>>;
  }
}

type Provider = "magsrv" | "pemsrv";

const SRC: Record<Provider, string> = {
  magsrv: "https://a.magsrv.com/ad-provider.js",
  pemsrv: "https://a.pemsrv.com/ad-provider.js",
};

const scriptInjected: Record<Provider, boolean> = {
  magsrv: false,
  pemsrv: false,
};

function ensureGlobal(): void {
  if (typeof window === "undefined") return;
  if (!Array.isArray(window.AdProvider)) {
    window.AdProvider = [];
  }
}

/**
 * provider 用 ad-provider.js を 1 回だけ <head> に挿入する。
 * 公式タグ同様 async でロードし、完了を待たない。
 */
function ensureProviderScript(provider: Provider): void {
  if (typeof window === "undefined") return;
  if (scriptInjected[provider]) return;
  const existing = document.querySelector<HTMLScriptElement>(
    `script[data-ad-provider="${provider}"]`,
  );
  if (existing) {
    scriptInjected[provider] = true;
    return;
  }
  const s = document.createElement("script");
  s.async = true;
  s.type = "application/javascript";
  s.src = SRC[provider];
  s.dataset.adProvider = provider;
  document.head.appendChild(s);
  scriptInjected[provider] = true;
}

/**
 * `AdProvider.push({ serve: {} })` を公式タグ準拠で同期的に呼ぶ。
 *
 * 呼び出し元は <ins> を DOM に描画したあとの useEffect 内でこれを叩く。
 * script のロード完了は待たない (待つと配列キュー差し替え後の挙動と噛み合わない)。
 */
export function serveAd(provider: Provider): void {
  if (typeof window === "undefined") return;
  ensureGlobal();
  ensureProviderScript(provider);
  try {
    window.AdProvider!.push({ serve: {} });
  } catch {
    /* ロード失敗時等は何もしない (広告ブロッカー対策) */
  }
}
