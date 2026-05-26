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
 * --- 「null length」例外について ---
 *
 * ad-provider.js は内部で `<ins data-zoneid>` 群を `getElementsByClassName` 等で
 * 引いてループするが、引いた結果が空 / 一部 null だと
 * `Cannot read properties of null (reading 'length')` を吐く。
 * これは ad-provider 内部のバグだが、こちらでは
 *   1. <ins> が DOM に居ない状況では push しない
 *   2. window-level に error filter を入れて React scheduler を巻き込まない
 * の 2 段構えで影響を抑える。
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

let errorFilterInstalled = false;

/**
 * ad-provider.js の `Cannot read properties of null (reading 'length')` を
 * window.onerror から握りつぶす filter を 1 回だけ仕掛ける。
 *
 * React のグローバル error listener / devtools の error 表示が走るとそれ自体が
 * メインスレッドを取り、最初の動画フレーム描画を削ってしまう。広告ライブラリの
 * 内部例外はこちらでハンドリングしようがないので、`event.preventDefault()` で
 * 抑えるだけにする。
 *
 * 注意:
 *   - capture フェーズで取らないと React 側が先に拾うのでこちらでは抑えられない。
 *   - 抑える対象は `filename` または `error.stack` に "ad-provider.js" を含むものに限定し、
 *     アプリ本体の例外までは黙らせない。
 */
function ensureErrorFilter(): void {
  if (errorFilterInstalled) return;
  if (typeof window === "undefined") return;
  errorFilterInstalled = true;

  const handler = (e: ErrorEvent): void => {
    const filename = e.filename ?? "";
    const stack = (e.error as { stack?: string } | null | undefined)?.stack ?? "";
    if (filename.includes("ad-provider.js") || stack.includes("ad-provider.js")) {
      // ad-provider 内部の null/length 例外は無害なので noise を消すだけ。
      // ロギングしたい場合は dev/vt=1 のみ。
      e.preventDefault();
      e.stopImmediatePropagation();
      try {
        if (
          process.env.NODE_ENV !== "production" ||
          window.location?.search?.includes("vt=1")
        ) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ads-gate suppressed ad-provider error: ${e.message ?? ""}`,
          );
        }
      } catch {
        /* ignore */
      }
    }
  };
  window.addEventListener("error", handler, /* capture */ true);
}

function ensureGlobal(): void {
  if (typeof window === "undefined") return;
  if (!Array.isArray(window.AdProvider)) {
    window.AdProvider = [];
  }
}

/**
 * 該当 provider 用の <ins data-zoneid> が DOM に 1 つでも居るか。
 *
 * 居ない状態で `AdProvider.push({serve:{}})` を呼ぶと ad-provider.js が内部で
 * `null.length` を踏みやすいので、こちら側でガードする。
 *
 * ExoClick の <ins> はクラス名 (`eas6a97888e...`) で識別される設計なので、
 * "ad-provider script を必要としている <ins>" 全般を `[class^="eas6a97888"]`
 * で取る。zone ごとにクラスが違うため細分化はしない (= 1 つでも対象の <ins>
 * があれば push する)。
 */
function hasInsForProvider(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('ins[class^="eas6a97888"][data-zoneid]') != null;
}

/**
 * provider 用 ad-provider.js を 1 回だけ <head> に挿入する。
 *
 * 公式タグ同様 async でロードし、完了を待たない。
 *
 * "ads-ready" ゲート (adReadyGate) を通すことで、最初の active 動画が playing
 * に達するか、idle タイマー (10s) が発火するまでスクリプトの実 fetch / 評価を
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
    // ready 到達時点でこの provider 用 <ins> が DOM に居ないなら、まだスクリプトを
    // 入れない (入れても何もしないどころか null/length 例外を起こすため)。
    // 後で <ins> が DOM に入ったタイミングで serveAd / resetAndServeAd が呼ばれた
    // 際にもう一度ここを通すため、scriptInjected を false に戻しておく。
    if (!hasInsForProvider()) {
      scriptInjected[provider] = false;
      return;
    }
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
 *
 * <ins> が DOM に 1 つも居ない状態では push をスキップする (ad-provider.js 内部の
 * null/length 例外を回避するため)。
 */
export function serveAd(provider: Provider): void {
  if (typeof window === "undefined") return;
  ensureErrorFilter();
  ensureGlobal();
  ensureProviderScript(provider);
  if (!hasInsForProvider()) {
    // 呼び元の <ins> がまだ DOM に居ない (= マウント直後で ref がついていない、
    // または広告が無効化されている等)。push を打つと ad-provider が空配列を
    // 走査して null/length 例外を吐くので、ここでスキップする。
    // 次に <ins> が見えてからの useEffect 内 serveAd でリトライされる前提。
    return;
  }
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
 *
 * <ins> が DOM に居ない場合は reset 自体をスキップする (= 何もしない)。
 */
export function resetAndServeAd(provider: Provider): void {
  if (typeof window === "undefined") return;
  ensureErrorFilter();
  if (!hasInsForProvider()) {
    return;
  }
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
