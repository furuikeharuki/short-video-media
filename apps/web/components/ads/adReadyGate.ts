/**
 * 広告 provider (ExoClick ad-provider.js) のロードを「最初の active 動画が
 * 再生可能 (canplay) に達するか、ページ全体が idle になる」まで遅延させるためのゲート。
 *
 * 動機:
 *   ad-provider.js は <script async> でロードされても評価コスト・XHR コスト・
 *   ライブラリの内部例外 (`Cannot read properties of null (reading 'length')`) が
 *   メインスレッドを占有し、active <video> の Range request 開始や React の
 *   コミットを数百 ms 単位で遅らせていた。プレイヤーが「最初の 1 本」を再生し
 *   始めてからは多少のスレッド占有は許容できる。
 *
 * モデル:
 *   - 起動時: ready=false。
 *   - 誰かが whenAdsReady() を最初に呼んだタイミングで、フォールバック timer
 *     (AUTO_READY_FALLBACK_MS) を仕掛ける。これにより active <video> が一切
 *     現れないページ (例: 静的ページ) でも一定時間で必ず ready になる。
 *   - signalAdsReady() が外部 (= active <video> の canplay 観測者) から呼ばれた
 *     瞬間に ready=true に遷移し、キューされた callback を全て実行 + フォールバックを解除。
 *   - 一度 ready になったら以降の whenAdsReady() は同期実行。
 *
 * これによって ad-provider script の <script> 注入と AdProvider.push の駆動が
 * 「最初の動画が再生開始する → そのフレームのレンダリングが完了する」までは
 * 走らなくなる。プッシュした serve コマンド自体は AdProvider 配列にキューされる
 * (まだ script の load が走っていない間) ので、表示順は崩れない。
 */

type ReadyCallback = () => void;

const AUTO_READY_FALLBACK_MS = 4000;

let ready = false;
const queue: ReadyCallback[] = [];
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  if (!ready) return;
  // queue を切り出してから順次実行 (実行中に whenAdsReady 再帰呼び出しが起きても
  // 残り queue がきれいに処理されるように)。
  const pending = queue.splice(0);
  for (const cb of pending) {
    try {
      cb();
    } catch {
      /* 個別 callback のエラーは握りつぶす (他の callback に影響させない) */
    }
  }
}

function ensureFallback(): void {
  if (typeof window === "undefined") return;
  if (ready) return;
  if (fallbackTimer != null) return;
  fallbackTimer = setTimeout(() => {
    fallbackTimer = null;
    signalAdsReady();
  }, AUTO_READY_FALLBACK_MS);
}

/**
 * 広告ロードを許可する。idempotent。
 * - active <video> の canplay 観測者 (FeedItem の handleCanPlay) から呼ぶ。
 * - フォールバック timer も同時に解除する。
 */
export function signalAdsReady(): void {
  if (ready) return;
  ready = true;
  if (fallbackTimer != null) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
  flush();
}

/** 現在の ready 状態を取得する (デバッグ・テスト用)。 */
export function isAdsReady(): boolean {
  return ready;
}

/**
 * 広告 ready 後に実行する callback を登録する。
 * - 既に ready の場合は同期実行。
 * - そうでない場合はキューに積み、最初の登録でフォールバック timer を仕掛ける。
 */
export function whenAdsReady(cb: ReadyCallback): void {
  if (ready) {
    try {
      cb();
    } catch {
      /* ignore */
    }
    return;
  }
  queue.push(cb);
  ensureFallback();
}
