/**
 * ExoClick の ad-provider.js を 1 度だけロードするためのユーティリティ。
 *
 * provider は 2 系統:
 *  - magsrv: native / mobile banner 用 (`https://a.magsrv.com/ad-provider.js`)
 *  - pemsrv: fullpage interstitial 用 (`https://a.pemsrv.com/ad-provider.js`)
 *
 * どちらも `window.AdProvider` という同名 (但しスクリプト的には別物) のグローバル配列を
 * 共有する設計のため、同じスクリプトの重複ロードは避ける。`AdProvider.push({serve:{}})`
 * 自体は各広告枠の mount 後に AdSlot 側から呼ぶ。
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

const loadState: Record<Provider, "idle" | "loading" | "loaded" | "error"> = {
  magsrv: "idle",
  pemsrv: "idle",
};

const waiters: Record<Provider, Array<() => void>> = {
  magsrv: [],
  pemsrv: [],
};

function ensureGlobal(): void {
  if (typeof window === "undefined") return;
  if (!Array.isArray(window.AdProvider)) {
    window.AdProvider = [];
  }
}

/**
 * provider 用 ad-provider.js を 1 回だけロードし、ロード完了で resolve する。
 * 既にロード済みなら即 resolve。
 */
export function loadAdProvider(provider: Provider): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  ensureGlobal();

  if (loadState[provider] === "loaded") return Promise.resolve();
  if (loadState[provider] === "error") return Promise.reject(new Error("ad provider load failed"));

  return new Promise<void>((resolve, reject) => {
    waiters[provider].push(() => resolve());

    if (loadState[provider] === "loading") return;
    loadState[provider] = "loading";

    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-ad-provider="${provider}"]`,
    );
    if (existing) {
      // 何らかの理由で他経路から挿入済み。ロード済みとみなす。
      loadState[provider] = "loaded";
      const list = waiters[provider].splice(0);
      list.forEach((fn) => fn());
      resolve();
      return;
    }

    const s = document.createElement("script");
    s.async = true;
    s.type = "application/javascript";
    s.src = SRC[provider];
    s.dataset.adProvider = provider;
    s.onload = () => {
      loadState[provider] = "loaded";
      const list = waiters[provider].splice(0);
      list.forEach((fn) => fn());
    };
    s.onerror = () => {
      loadState[provider] = "error";
      const _list = waiters[provider].splice(0);
      reject(new Error("ad provider load failed"));
    };
    document.head.appendChild(s);
  });
}

/**
 * `AdProvider.push({ serve: {} })` を安全に呼ぶ。
 * provider script のロード完了を待ってから push する。
 */
export async function serveAd(provider: Provider): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    await loadAdProvider(provider);
    ensureGlobal();
    window.AdProvider!.push({ serve: {} });
  } catch {
    // ロード失敗時は何もしない (広告ブロッカー等)
  }
}
