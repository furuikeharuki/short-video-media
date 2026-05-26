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
 * ページで何度も呼ぶと、まだ serve 中の他の枠まで巻き添えで殺してしまう。
 */

import { whenAdsReady } from "./adReadyGate";

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

/**
 * 直近の reset 実行時刻。短時間に複数回呼ばれても 1 回だけ効かせるためのクールダウン。
 *
 * 値を小さくする理由:
 * ホーム→マイページ→ホーム と遷移すると Next.js App Router は force-dynamic ページを
 * サーバから再レンダリングするため AdSlot がアンマウント→再マウントされる。
 * その際に複数 AdSlot が同時に mount されて同時に resetAndServeAd を呼ぶが、
 * その「複数呼び」を 1 回に抑えたいだけで、
 * 「遷移自体の長さ」よりも小さい値にする必要はない。
 * 300ms で十分。
 */
const RESET_COOLDOWN_MS = 300;

function ensureGlobal(): void {
  if (typeof window === "undefined") return;
  if (!Array.isArray(window.AdProvider)) {
    window.AdProvider = [];
  }
}

/**
 * provider 用 ad-provider.js を 1 回だけ <head> に挿入する。
 *
 * 公式タグ同様 async でロードし、完了を待たない。
 *
 * "ads-ready" ゲート (adReadyGate) を通すことで、最初の active 動画が canplay
 * に達するか、idle タイマー (4s) が発火するまでスクリプトの実 fetch / 評価を
 * 遅延させる。これにより初回再生開始までのメインスレッドを ad-provider.js の
 * パース・実行・内部例外で奪われない。
 *
 * 注意: AdProvider 配列への push はこのゲートとは独立に即時で行う (serveAd 側)。
 *      配列は ad-provider.js ロード後に「自身の push 実装に差し替え + 未処理要素を走査」
 *      するため、push の順序は失われない。
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
  // ロード予約を 1 回だけ。ready 前に複数 AdSlot が ensureProviderScript を呼んでも
  // 1 つしか script は挿入されない。
  scriptInjected[provider] = true;
  whenAdsReady(() => {
    // ready 待ちの間に別経路で script タグが入った場合は何もしない。
    const already = document.querySelector<HTMLScriptElement>(
      `script[data-ad-provider="${provider}"]`,
    );
    if (already) return;
    const s = document.createElement("script");
    s.async = true;
    s.type = "application/javascript";
    s.src = SRC[provider];
    s.dataset.adProvider = provider;
    document.head.appendChild(s);
  });
}

/**
 * `AdProvider.push({ serve: {} })` を公式タグ準拠で同期的に呼ぶ。
 *
 * 呼び元は <ins> を DOM に描画したあとの useEffect 内でこれをたたく。
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
 *   4) 即時 push({serve:{}}) (ロード前ならキューに溜まり、ロード後の初期
 *      スキャンで未処理 <ins> 群と一緒に処理される)
 */
export function resetAndServeAd(provider: Provider): void {
  if (typeof window === "undefined") return;
  const now = Date.now();
  // lastResetAt を window に持たせる。
  // モジュールレベル変数は Next.js の Hot Module Replacement でリセットされないが、
  // window はページ遷移でリセットされるためクールダウンも正しくリセットされる。
  const WIN_KEY = `__adResetAt_${provider}` as keyof Window;
  const lastReset = (window[WIN_KEY] as number | undefined) ?? 0;
  if (now - lastReset < RESET_COOLDOWN_MS) {
    // 直近で reset 済み。並行した他 AdSlot からの呼び出しの場合は何もしない。
    // (既に reset 後の serve が走っているので追加 serveAd 不要)
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any)[WIN_KEY] = now;

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
