/**
 * ExoClick の ad-provider.js を扱うためのユーティリティ。
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
 *
 * --- SPA でのナビゲーション復帰 ---
 *
 * ad-provider.js は SPA で後から DOM に挿入された <ins> を取りこぼすことがある。
 * その救済として `resetProvider(provider)` を用意するが、これは「ページ全体で
 * 一度だけ・1 ティック内で 1 度だけ」に限定して呼ぶこと。複数 <AdSlot> が同居する
 * ページで何度も呼ぶと、まだ serve 中の他の枠まで巻き添えで空にしてしまう。
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

// 直近の reset 実行時刻。短時間に複数回呼ばれても 1 回だけ効かせるためのクールダウン。
const lastResetAt: Record<Provider, number> = {
  magsrv: 0,
  pemsrv: 0,
};
const RESET_COOLDOWN_MS = 1500;

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

/**
 * provider の状態を完全リセットしてから serve を呼び直す。
 *
 * 用途: ホームに戻ってきた直後など「現在 DOM にいる <ins> 群を一括で拾い直したい」
 *      タイミングで呼ぶ。クールダウン (RESET_COOLDOWN_MS) を入れてあるので、複数の
 *      AdSlot が同時に呼んでも 1 回しか効かない。
 *
 * 実装:
 *   1) 既存の <script data-ad-provider="..."> を削除
 *   2) window.AdProvider を空配列に置き直し (現 push 実装を捨てる)
 *   3) scriptInjected[provider]=false にして次回 ensureProviderScript で再注入
 *   4) 念のため即時 push({serve:{}}) (ロード前ならキューに溜まり、ロード後の初期
 *      スキャンで未処理 <ins> 群と一緒に処理される)
 */
export function resetAndServeAd(provider: Provider): void {
  if (typeof window === "undefined") return;
  const now = Date.now();
  if (now - lastResetAt[provider] < RESET_COOLDOWN_MS) {
    // 直近で reset 済み。重ねて捨てると serve 中の他枠を殺すので普通の serve だけ。
    serveAd(provider);
    return;
  }
  lastResetAt[provider] = now;

  const scripts = document.querySelectorAll<HTMLScriptElement>(
    `script[data-ad-provider="${provider}"]`,
  );
  scripts.forEach((s) => s.parentNode?.removeChild(s));
  window.AdProvider = [];
  scriptInjected[provider] = false;

  ensureGlobal();
  ensureProviderScript(provider);
  try {
    window.AdProvider!.push({ serve: {} });
  } catch {
    /* ignore */
  }
}
