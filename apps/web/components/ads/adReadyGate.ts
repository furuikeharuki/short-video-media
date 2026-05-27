/**
 * 広告 provider (ExoClick ad-provider.js) のロードを「最初の active 動画が
 * 安定して再生し続けていて、かつブラウザが idle になる」まで遅延させるためのゲート。
 *
 * 背景:
 *   ad-provider.js は <script async> でロードしてもパース + XHR + 内部例外
 *   (`Cannot read properties of null (reading 'length')`) でメインスレッドを
 *   占有し、active <video> の Range request 開始や React のコミットを数百ms〜
 *   数秒単位で遅らせる (実観測で 'readystatechange' handler took 3113ms)。
 *
 *   従来は単純な「最初の canplay で signal、もしくは 10s 経過でフォールバック」
 *   の構造だったが、初回 canplay が遅延 (4G 低速、コールドキャッシュ等で 10s
 *   超え) するケースでは fallback が active の critical path 中に発火し、
 *   ad-provider のパースが active の再生を更に遅らせる悪循環になっていた。
 *
 * 新モデル (stability gate):
 *   - whenAdsReady(cb) はキューに積むだけ。
 *   - signalPlaying() で「active が playing 状態に入った」ことを通知。
 *     PLAYBACK_STABLE_MS (3s) のタイマーを開始する。
 *   - タイマーが満了すると requestIdleCallback (fallback setTimeout) で
 *     flush を予約する。idle が来ない場合の保険として IDLE_TIMEOUT_MS で必ず実行。
 *   - signalUnstable() (= waiting / stalled / error / 非 active 化) で
 *     stable タイマーを取り消す。次の signalPlaying で再カウントになる。
 *   - 一度 flush したら ready=true のまま固定。以降の whenAdsReady() は同期実行。
 *
 *   →「再生がまだ始まっていない」「再生は始まったが直後にバッファリングしている」
 *     どちらの状態でも広告ロードを開始しない。広告は active が「安定して」
 *     再生し続けていることが確認できてから初めて入る。
 *
 *   旧 API の signalAdsReady() は signalPlaying() の alias として残す。
 *
 * 時間チューニング:
 *   - PLAYBACK_STABLE_MS = 3000ms
 *     1s でユーザーの「最初の 1 本が再生された」体感は満たす。
 *     +2s 待つことで、最初の playing から直後に waiting/stalled に落ちる
 *     ケース (4G モバイル / Range buffer 不足) を吸収する。
 *   - IDLE_TIMEOUT_MS = 2000ms
 *     stable タイマー満了後、requestIdleCallback の timeout 上限。
 *     idle が来ない環境 (持続的に他処理が走っている) でも最大 2s で flush。
 *   - NO_VIDEO_FALLBACK_MS = 4000ms
 *     ホーム / 一覧 / 検索 / 詳細など <video> が無いページにも AdSlot が居る。
 *     これらのページでは signalPlaying() が永久に来ないため、AdSlot 自身が
 *     mount 時に signalAdSlotMounted() を呼んで「これ以上動画 signal を
 *     待つべきではない」を宣言する。signalPlaying() が先に来れば従来通り
 *     stable タイマーで gate を開く。動画 signal が来なければ
 *     NO_VIDEO_FALLBACK_MS 後に gate を強制 ready にして広告ロードを許可する。
 *     /feed の videoplayer は通常 1〜2s で playing に入るので、fallback が
 *     stable timer より早く ready 化することは無く、/feed 側の挙動には影響しない。
 */

type ReadyCallback = () => void;

const PLAYBACK_STABLE_MS = 3000;
const IDLE_TIMEOUT_MS = 2000;
const NO_VIDEO_FALLBACK_MS = 4000;

let ready = false;
const queue: ReadyCallback[] = [];
let stableTimer: ReturnType<typeof setTimeout> | null = null;
let idleHandle: number | null = null;
let idleFallbackTimer: ReturnType<typeof setTimeout> | null = null;
let noVideoFallbackTimer: ReturnType<typeof setTimeout> | null = null;

interface IdleDeadline {
  didTimeout: boolean;
  timeRemaining: () => number;
}

type RequestIdleCallback = (
  cb: (deadline: IdleDeadline) => void,
  opts?: { timeout?: number },
) => number;
type CancelIdleCallback = (handle: number) => void;

function vtEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      process.env.NODE_ENV !== "production" ||
      window.location?.search?.includes("vt=1") ||
      window.localStorage?.getItem("video_timing") === "1"
    );
  } catch {
    return false;
  }
}

function vt(msg: string): void {
  if (!vtEnabled()) return;
  try {
    // eslint-disable-next-line no-console
    console.debug(`vt ads-gate ${msg}`);
  } catch {
    /* ignore */
  }
}

function flush(): void {
  if (!ready) return;
  const pending = queue.splice(0);
  vt(`flush n=${pending.length}`);
  for (const cb of pending) {
    try {
      cb();
    } catch {
      /* 個別 callback のエラーは握りつぶす */
    }
  }
}

function cancelIdleSchedule(): void {
  if (typeof window === "undefined") return;
  if (idleHandle != null) {
    const cancel = (window as unknown as { cancelIdleCallback?: CancelIdleCallback })
      .cancelIdleCallback;
    if (typeof cancel === "function") {
      try {
        cancel(idleHandle);
      } catch {
        /* ignore */
      }
    }
    idleHandle = null;
  }
  if (idleFallbackTimer != null) {
    clearTimeout(idleFallbackTimer);
    idleFallbackTimer = null;
  }
}

function scheduleFlushOnIdle(): void {
  if (typeof window === "undefined") {
    flush();
    return;
  }
  if (idleHandle != null || idleFallbackTimer != null) return;
  const ric = (window as unknown as { requestIdleCallback?: RequestIdleCallback })
    .requestIdleCallback;
  const run = (): void => {
    idleHandle = null;
    if (idleFallbackTimer != null) {
      clearTimeout(idleFallbackTimer);
      idleFallbackTimer = null;
    }
    vt("idle flush");
    flush();
  };
  if (typeof ric === "function") {
    try {
      idleHandle = ric(run, { timeout: IDLE_TIMEOUT_MS });
    } catch {
      idleHandle = null;
    }
  }
  // idleCallback 非対応 or 失敗時の保険、および ric の timeout が
  // 効かないブラウザの保険として、必ず setTimeout で fallback を仕掛ける。
  idleFallbackTimer = setTimeout(() => {
    idleFallbackTimer = null;
    if (idleHandle != null) {
      // ric が来る前に timeout したケース。ric は cancel する。
      cancelIdleSchedule();
    }
    vt("idle timeout flush");
    flush();
  }, IDLE_TIMEOUT_MS);
}

function clearStableTimer(): void {
  if (stableTimer != null) {
    clearTimeout(stableTimer);
    stableTimer = null;
  }
}

function clearNoVideoFallbackTimer(): void {
  if (noVideoFallbackTimer != null) {
    clearTimeout(noVideoFallbackTimer);
    noVideoFallbackTimer = null;
  }
}

/**
 * AdSlot が DOM に乗ったことを通知する。<video> が無いページ
 * (ホーム / 一覧 / 検索 / 詳細など) からの呼び出しを想定する。
 *
 * NO_VIDEO_FALLBACK_MS 後に signalPlaying() が来ていなければ gate を強制 ready
 * にする。signalPlaying() が先に来た場合は stable timer に処理を譲り、こちらは
 * キャンセルされる (clearNoVideoFallbackTimer)。
 *
 * idempotent: 既に ready / 既に fallback timer が走っていれば何もしない。
 * /feed のように複数 AdSlot (FeedAdSlide × N) が居るケースでも 1 回だけ起動。
 */
export function signalAdSlotMounted(): void {
  if (ready) return;
  if (noVideoFallbackTimer != null) return;
  vt(`adslot mounted -> no-video fallback timer start ${NO_VIDEO_FALLBACK_MS}ms`);
  noVideoFallbackTimer = setTimeout(() => {
    noVideoFallbackTimer = null;
    if (ready) return;
    // signalPlaying() が直近で来ていて stable timer が進行中なら、そちらに任せる。
    // /feed で動画が再生開始した直後に fallback が rapid-fire するのを避ける。
    if (stableTimer != null) return;
    vt("no-video fallback -> mark ready and schedule idle flush");
    ready = true;
    scheduleFlushOnIdle();
  }, NO_VIDEO_FALLBACK_MS);
}

/**
 * active <video> が playing 状態 (または canplay 後にすぐ再生される見込み) で
 * あることを通知する。idempotent: 既に stable timer が走っていれば何もしない。
 *
 * これにより PLAYBACK_STABLE_MS の安定タイマーを開始する。タイマー満了まで
 * waiting / stalled / 非 active 化を受け取らなければ ready=true にして
 * idle callback 経由で flush する。
 */
export function signalPlaying(): void {
  if (ready) return;
  if (stableTimer != null) return;
  vt(`playing -> stable timer start ${PLAYBACK_STABLE_MS}ms`);
  stableTimer = setTimeout(() => {
    stableTimer = null;
    ready = true;
    clearNoVideoFallbackTimer();
    vt("stable -> schedule idle flush");
    scheduleFlushOnIdle();
  }, PLAYBACK_STABLE_MS);
}

/**
 * active <video> が waiting / stalled / error などで再生が安定していないことを
 * 通知する。stable timer をキャンセルし、再度 signalPlaying() が呼ばれた
 * タイミングからカウントし直す。
 *
 * 既に ready 確定後 (flush 予約済み / 完了済み) は無視する。
 * 一度 ready になった広告枠を再度封じるとサイトの動作が破綻するため。
 */
export function signalUnstable(reason: string): void {
  if (ready) return;
  if (stableTimer == null) return;
  vt(`unstable reason=${reason} -> cancel stable timer`);
  clearStableTimer();
}

/**
 * 後方互換 API。canplay 観測などから「今 ready にしてよい」を通知する。
 * 新モデルでは signalPlaying() と等価に扱う。
 */
export function signalAdsReady(): void {
  signalPlaying();
}

/** 現在の ready 状態を取得する (デバッグ・テスト用)。 */
export function isAdsReady(): boolean {
  return ready;
}

/**
 * 広告 ready 後に実行する callback を登録する。
 * - 既に ready の場合は同期実行。
 * - そうでない場合はキューに積む (signal* がフローを進める)。
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
}
