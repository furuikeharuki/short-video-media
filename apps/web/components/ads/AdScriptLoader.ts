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
 * 短時間に複数回呼ばれたときに連続 push を最小に抑えるための薄いクールダウン。
 *
 * 以前は destructive reset (script 削除 + window.AdProvider 置換) を 1 回に絞るために
 * 300ms 設定だったが、destructive reset を廃止 (provider 内部状態の破壊を防ぐため)
 * してからは「単なる push({serve:{}}) を 1 回に抑える」用途しか残っていない。
 *
 * 300ms にしてしまうと、ページ AdSlot が serve した直後 (80ms) に 詳細モーダルの
 * AdSlot が mount → serve しても cooldown に弾かれてしまい、モーダルの \`<ins>\` が
 * 永遠に埋まらない不具合になる。 30ms 程度に下げて「同じ tick での多重 push のみ抑制」
 * とし、別 AdSlot のための serve はちゃんと通すようにする。
 */
const RESET_COOLDOWN_MS = 30;

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
 * provider に「もう一度 serve をかけて DOM を rescan させる」よう依頼する。
 *
 * 用途: ホームに戻ってきた直後など「現在 DOM にいる <ins> 群を一括で拾い直したい」
 *      タイミングで呼ぶ。クールダウン (RESET_COOLDOWN_MS) を入れてあるので、複数の
 *      AdSlot が同時に呼んでも 1 回しか効かない。
 *
 * 以前は「<script> を削除 → \`window.AdProvider = []\` で push 実装を破棄 →
 *  再注入 → push」という destructive reset を行っていたが、これが原因で
 *  ad-provider.js 内部の setTimeout ループが破棄済みの内部キューを参照し
 *  \`Cannot read properties of null (reading 'length')\` を連発させていた。
 *  provider はロード後に自前で DOM を再スキャンするので、明示 push だけで十分。
 *  destructive reset は廃止する。
 */
export function resetAndServeAd(provider: Provider): void {
  if (typeof window === "undefined") return;
  const now = Date.now();
  const WIN_KEY = `__adResetAt_${provider}` as keyof Window;
  const lastReset = (window[WIN_KEY] as number | undefined) ?? 0;
  if (now - lastReset < RESET_COOLDOWN_MS) {
    // 直近で reset 済み。並行した他 AdSlot からの呼び出しの場合は何もしない。
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any)[WIN_KEY] = now;

  // <script> や window.AdProvider は触らない (provider 内部の状態を壊さないため)。
  // 単純に再 serve を依頼するだけ。
  serveAd(provider);
}
