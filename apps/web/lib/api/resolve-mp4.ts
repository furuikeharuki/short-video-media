/**
 * GET /api/v1/movies/{slug}/resolve-mp4 を叩いて、再生可能な MP4 URL を取得する。
 *
 * API 側は DB キャッシュを廃止しており、毎回 in-process httpx で DMM の
 * html5_player ページから抽出する。連打抑制は API 側の in-flight デデュープ
 * + 1 時間の短期成功キャッシュとクライアント側のメモリキャッシュで二重に行う。
 *
 * - force=false (デフォルト): クライアント側 / サーバ側両方のメモリキャッシュ優先。
 * - force=true: <video> が再生エラーになったときのリトライ用。サーバ側の
 *   短期キャッシュもバイパスして DMM へ再アクセスさせる。
 *
 * 失敗時は null を返してサムネにフォールバック (例外は投げない)。
 */

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000";

export type ResolveMp4Response = {
  content_id: string | null;
  /**
   * 再生可能な MP4 URL。
   * 互換フィールド。フィードでは `low_mp4_url || mp4_url` で即開始し、
   * 再生が安定してから `high_mp4_url || mp4_url` に切り替える。
   */
  mp4_url: string;
  /** 高画質候補 (あれば優先採用)。なければ mp4_url で再生。 */
  high_mp4_url?: string | null;
  /** 低画質候補。フィードの初速優先再生で使う。 */
  low_mp4_url?: string | null;
};

/** 互換用の高画質寄り URL 選択。詳細ページや force retry の最終候補で使う。 */
export function pickPlaybackUrl(res: {
  mp4_url: string;
  high_mp4_url?: string | null;
}): string {
  return res.high_mp4_url || res.mp4_url;
}

/** フィード初速優先の開始 URL。低画質候補があれば最優先で使う。 */
export function pickFastStartUrl(res: {
  mp4_url: string;
  low_mp4_url?: string | null;
}): string {
  return res.low_mp4_url || res.mp4_url;
}

/** 最終的に寄せる高画質 URL。既存の pickPlaybackUrl と同じ選択を明示名で公開する。 */
export function pickHighQualityUrl(res: {
  mp4_url: string;
  high_mp4_url?: string | null;
}): string {
  return pickPlaybackUrl(res);
}

/**
 * URL 末尾ファイル名から DMM サンプル動画の画質ティアを推定する。
 *
 * DMM の命名規則 (低 → 高):
 *   _sm_w.mp4  : small  (最も軽量 / SD)
 *   _dm_w.mp4  : medium (中)
 *   _dmb_w.mp4 : medium-bitrate (中の上、_dm_w より高ビットレート)
 *   _mhb_w.mp4 : medium-high bitrate (HD 相当、最高画質)
 *
 * コンパクト形 (近年 DMM が併用):
 *   <cid>sm.mp4 / <cid>dm.mp4 / <cid>dmb.mp4 / <cid>mhb.mp4
 * 例: `sone00614sm.mp4`, `yrnkmtndvaj00703bsm.mp4`, `1sun00052amhb.mp4`。
 *
 * DMM cid は **英字 + 数字** の混在で、末尾が英字のケースが普通にある
 * (`yrnkmtndvaj00703b` 等)。tier 直前が「非小文字英字」を必須にすると cid
 * 末尾英字パターンが落ちる (PR #286 の bug)。代わりに「basename のどこかに
 * 数字が出現してから tier に到達する」を条件にして、純文字列の偽 basename
 * (`prism.mp4` 等) を弾きつつ cid 末尾英字を許容する。
 *
 * tier は longest-first (`mhb|dmb|dm|sm`) で並べ、`...dmb.mp4` を `dm` に
 * 誤判定しない。
 *
 * vt ログ用の安全な短いラベル。トークン付きクエリは含まない。
 */
const COMPACT_SUFFIX_RE = /\d[a-z]*(mhb|dmb|dm|sm)\.mp4$/i;

function basenameOf(url: string): string {
  let s = url;
  const q = s.indexOf("?");
  if (q >= 0) s = s.substring(0, q);
  const h = s.indexOf("#");
  if (h >= 0) s = s.substring(0, h);
  const slash = s.lastIndexOf("/");
  return slash >= 0 ? s.substring(slash + 1) : s;
}

export function inferQualityTier(url: string | null | undefined): string {
  if (!url) return "unknown";
  if (url.includes("_mhb_w.mp4")) return "mhb";
  if (url.includes("_dmb_w.mp4")) return "dmb";
  if (url.includes("_dm_w.mp4")) return "dm";
  if (url.includes("_sm_w.mp4")) return "sm";
  // コンパクト形は basename 末尾だけを見る (`xxxxsm.mp4` 等)。
  const m = COMPACT_SUFFIX_RE.exec(basenameOf(url));
  if (m) return m[1].toLowerCase();
  return "other";
}

/** 署名クエリを除いた host だけを vt ログ向けに取り出す。 */
export function extractHost(url: string | null | undefined): string {
  if (!url) return "?";
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}

/**
 * URL のファイル basename だけを安全に取り出す。クエリ / hash / 親パスは含めない。
 *
 * 用途: `inferQualityTier` が `other` を返した URL について、DMM が出している
 * 実サフィックスを vt ログに残し、コード側のサフィックス辞書を拡張すべきかを
 * 観測するためのもの。
 *
 * セキュリティ: 署名トークン入りクエリやパスを誤って残さないため、
 *   - URL.pathname の最後のセグメントのみを採用
 *   - 英数 / `_` / `.` / `-` 以外を含む場合は "?" を返す (= ログ汚染防止)
 *   - 長すぎる basename (>64 char) は "?" を返す (= 異常入力の遮断)
 *
 * 不正値 / null / 解析不能 URL は "?" を返す。
 */
export function extractBasename(url: string | null | undefined): string {
  if (!url) return "?";
  try {
    const path = new URL(url).pathname;
    const last = path.substring(path.lastIndexOf("/") + 1);
    if (!last || last.length > 64) return "?";
    return /^[A-Za-z0-9._-]+$/.test(last) ? last : "?";
  } catch {
    return "?";
  }
}

/**
 * 優先度。
 *  - "high":   active 再生 (useResolvedVideoSrc)。waiters の先頭に割り込み、
 *              warm の低優先度上限 (activeLow) を無視して即発火。
 *  - "normal": 近距離 prefetch (current+1..+5)。FIFO で順次発火。
 *  - "low":    遠距離 warm (current+6..+15)。全体スロット (MAX_CONCURRENT_FETCHES)
 *              に加えて低優先度同時実行枠 (MAX_CONCURRENT_LOW) でも絞られる。
 *              これにより warm の実 HTTP 同時実行は最大 2 本に固定される。
 */
export type ResolvePriority = "high" | "normal" | "low";

export type ResolveOptions = {
  force?: boolean;
  signal?: AbortSignal;
  priority?: ResolvePriority;
  /** HTTP fetch が実際に開始した瞬間に 1 回だけ呼ばれる。`resolveMp4Url` を
   *  共有 (キャッシュ / in-flight 再利用) した consumer では呼ばれない。 */
  onStart?: () => void;
  /** 既存の in-flight / 成功キャッシュを再利用した瞬間に呼ばれる。 */
  onReuse?: (kind: "in-flight" | "cached") => void;
};

/**
 * クライアント側メモリ内 in-flight デデュープキャッシュ。
 *
 * 同じ slug を複数のコンポーネント (usePrefetchResolveMp4 / usePrefetchVideoBytes /
 * useResolvedVideoSrc) が同時に要求しても、API リクエストは 1 本にまとめる。
 *
 * AbortSignal の扱い (PR #95 → 改訂):
 *   - 内部 fetch には共用 AbortController を渡し、購読者 (consumer) を参照カウントで
 *     管理する。
 *   - 全ての consumer が abort された場合に限り、内部 fetch を実際に中断する。
 *   - これにより:
 *       * 高速スワイプで古い prefetch の signal が abort されても、まだ「中央に到達した
 *         useResolvedVideoSrc」など他の consumer が残っていれば fetch は止まらない。
 *       * 逆に、誰も必要としなくなった (全 consumer が abort) ケースでは
 *         無駄な resolver 呼び出しと帯域消費が実際に止まる。
 *   - force=true は常にキャッシュをバイパスして新規 fetch を立てる。
 */
type CacheEntry = {
  promise: Promise<ResolveMp4Response | null>;
  controller: AbortController;
  /** この in-flight に紐づく購読者数。0 になったら controller.abort()。 */
  refCount: number;
};

const resolveCache = new Map<string, CacheEntry>();

/**
 * 成功した resolve 結果の短期キャッシュ。
 *
 * in-flight キャッシュ (`resolveCache`) は全 consumer が abort されると
 * エントリごと消えるため、その後 active 再生がやって来ると改めて resolver を
 * 叩き直してしまっていた (vt ログで `resolve:start` の後 ~3s 待ちが見える原因)。
 *
 * 解決済みの mp4_url は API 側でも 1 時間キャッシュされている前提なので、
 * クライアントでも同じ時間覚えておき、in-flight が落ちた後でも即返せるようにする。
 * TTL は API 側と揃えて 1 時間。
 */
const SUCCESS_CACHE_TTL_MS = 60 * 60 * 1000;
// 長時間フィードを見続けると 1 時間 TTL 内に数百〜数千 slug が溜まり得る。
// 体感に効くのは直近で表示/先読みした近傍だけなので、挿入順 LRU で上限を設ける。
const SUCCESS_CACHE_MAX_ENTRIES = 256;
type SuccessEntry = { value: ResolveMp4Response; storedAt: number };
const successCache = new Map<string, SuccessEntry>();

function readSuccessCache(slug: string): ResolveMp4Response | null {
  const entry = successCache.get(slug);
  if (!entry) return null;
  if (Date.now() - entry.storedAt >= SUCCESS_CACHE_TTL_MS) {
    successCache.delete(slug);
    return null;
  }
  // Map の挿入順を更新して LRU として扱う。
  successCache.delete(slug);
  successCache.set(slug, entry);
  return entry.value;
}

function writeSuccessCache(slug: string, value: ResolveMp4Response): void {
  if (successCache.has(slug)) successCache.delete(slug);
  successCache.set(slug, { value, storedAt: Date.now() });
  while (successCache.size > SUCCESS_CACHE_MAX_ENTRIES) {
    const oldest = successCache.keys().next().value;
    if (oldest === undefined) break;
    successCache.delete(oldest);
  }
}

export function primeResolveMp4Cache(
  slug: string,
  value:
    | {
        content_id?: string | null;
        mp4_url?: string | null;
        low_mp4_url?: string | null;
        high_mp4_url?: string | null;
      }
    | null
    | undefined,
): boolean {
  if (!slug || !value?.mp4_url) return false;
  writeSuccessCache(slug, {
    content_id: value.content_id ?? null,
    mp4_url: value.mp4_url,
    low_mp4_url: value.low_mp4_url || value.mp4_url,
    high_mp4_url: value.high_mp4_url || value.mp4_url,
  });
  return true;
}

/**
 * resolver は uncached で ~8.6s かかるため、ブラウザから同時に多数のリクエストを
 * 投げると上流 (Cloudflare / API) で 504 が出やすい。並列度を上限 8 に絞ることで
 * バーストを抑制する (resolver / jobs-worker 側も実測で 8 が最適という前提)。
 *
 * 上限内: 即座に fetch を発火。
 * 上限超過: 優先度 ("high" / "normal" / "low") で並び替えた待ち行列に積み、
 *           空きが出たら優先度順 (FIFO 内) で起動。待機中に AbortController が
 *           abort された場合は fetch せずに諦める。
 *
 * 加えて、warm (priority="low") は同時実行を 2 本までに絞る。これは
 * 「warm が 8 本すべて埋めてしまい、active がスロット待ちになる」事態を避けるため。
 *
 * デデュープキャッシュ (resolveCache) は同一 slug の同時要求を 1 本にまとめる
 * 役割で、別 slug 同士の同時実行はここで絞る。
 */
const MAX_CONCURRENT_FETCHES = 8;
const MAX_CONCURRENT_LOW = 2;
/**
 * high priority 用の追加 burst 枠。global cap (MAX_CONCURRENT_FETCHES) を超えても
 * この数まで high は cap-bypass で即発火できる。これにより:
 *   - 通常 prefetch (priority="normal") / warm ("low") が global cap を埋めていても、
 *     active (priority="high") は待たずに resolver にアクセスできる。
 *   - 観測されていた「active resolve:ok +4.6s」のような high が cap 待ちで秒単位
 *     滞留するケースを解消する。
 * 余裕は控えめにして、上流 (Cloudflare / API) のバースト 504 を誘発しない程度に留める。
 */
const MAX_HIGH_BURST = 4;
let activeFetches = 0;
let activeLow = 0;
let activeHighBurst = 0;

type Waiter = {
  priority: ResolvePriority;
  /** 起こされたとき、どの slot kind を割り当てたかを渡す。 */
  wake: (kind: "global" | "high-burst") => void;
};
const waiters: Waiter[] = [];

function priorityRank(p: ResolvePriority): number {
  if (p === "high") return 0;
  if (p === "normal") return 1;
  return 2;
}

/** 起こせる waiter (現在のスロット余裕で起動可能なもの) を優先度順で取り出す。 */
function pickNextWaiterIndex(): number {
  let bestIdx = -1;
  let bestRank = Infinity;
  for (let i = 0; i < waiters.length; i += 1) {
    const w = waiters[i];
    if (w.priority === "low" && activeLow >= MAX_CONCURRENT_LOW) continue;
    const rank = priorityRank(w.priority);
    if (rank < bestRank) {
      bestRank = rank;
      bestIdx = i;
      if (rank === 0) break; // high は即決
    }
  }
  return bestIdx;
}

function canStartImmediately(priority: ResolvePriority): boolean {
  if (priority === "high") {
    // high は global cap を埋めていても burst 枠でバイパス可能。
    if (activeFetches < MAX_CONCURRENT_FETCHES) return true;
    if (activeHighBurst < MAX_HIGH_BURST) return true;
    return false;
  }
  if (activeFetches >= MAX_CONCURRENT_FETCHES) return false;
  if (priority === "low" && activeLow >= MAX_CONCURRENT_LOW) return false;
  return true;
}

/**
 * acquireSlot の結果。
 * - `false`: abort された (caller は fetch しない)。
 * - `"global"`: 通常 global slot を確保した。release で activeFetches を 1 減らす。
 * - `"high-burst"`: high の burst 枠を使った。release で activeHighBurst を 1 減らす。
 */
type SlotKind = false | "global" | "high-burst";

function acquireSlot(
  signal: AbortSignal,
  priority: ResolvePriority,
): Promise<SlotKind> {
  if (signal.aborted) return Promise.resolve(false);
  if (canStartImmediately(priority)) {
    if (priority === "high" && activeFetches >= MAX_CONCURRENT_FETCHES) {
      activeHighBurst += 1;
      return Promise.resolve("high-burst");
    }
    activeFetches += 1;
    if (priority === "low") activeLow += 1;
    return Promise.resolve("global");
  }
  return new Promise<SlotKind>((resolve) => {
    const waiter: Waiter = {
      priority,
      wake: (kind) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          // 起こされたが既に abort 済み → 受け取った slot を次の waiter に渡す
          releaseSlot(kind, priority);
          resolve(false);
          return;
        }
        resolve(kind);
      },
    };
    const onAbort = () => {
      const idx = waiters.indexOf(waiter);
      if (idx >= 0) waiters.splice(idx, 1);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    waiters.push(waiter);
  });
}

function releaseSlot(kind: Exclude<SlotKind, false>, priority: ResolvePriority): void {
  if (kind === "high-burst") {
    // burst 枠を 1 つ返す。
    activeHighBurst = Math.max(0, activeHighBurst - 1);
    // burst が空いたので、待機中の high waiter があれば優先的に起こす
    // (低 priority は global slot 占有のままなので起こさない)。
    for (let i = 0; i < waiters.length; i += 1) {
      const w = waiters[i];
      if (w.priority !== "high") continue;
      waiters.splice(i, 1);
      activeHighBurst += 1;
      w.wake("high-burst");
      break;
    }
    return;
  }
  // まず開放: low サブカウンタを下げる (グローバルは waiter に引き継ぐかここで下げる)。
  if (priority === "low") {
    activeLow = Math.max(0, activeLow - 1);
  }
  const idx = pickNextWaiterIndex();
  if (idx >= 0) {
    const [next] = waiters.splice(idx, 1);
    // グローバルスロット (activeFetches) は据え置きで次の consumer に引き継ぐ。
    // 次が low なら activeLow を再度 +1。
    if (next.priority === "low") {
      activeLow += 1;
    }
    next.wake("global");
  } else {
    activeFetches = Math.max(0, activeFetches - 1);
  }
}

/** 504 / ネットワークエラーに対するリトライ待ち時間 (1.5〜3.0s ジッタ)。 */
function pickRetryDelayMs(): number {
  return 1500 + Math.floor(Math.random() * 1500);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function resolveMp4Url(
  slug: string,
  options: ResolveOptions = {},
): Promise<ResolveMp4Response | null> {
  if (!slug) return null;

  // 呼び出し元の signal が既に abort されていれば即座に null。
  if (options.signal?.aborted) return null;

  const priority: ResolvePriority = options.priority ?? "normal";

  // force=false のケース、既にキャッシュにあればそれを共有する。
  if (!options.force) {
    // 1. 成功キャッシュにヒットすれば即返す。
    const cached = readSuccessCache(slug);
    if (cached) {
      options.onReuse?.("cached");
      return cached;
    }
    // 2. in-flight 共有があればタダ乗り。
    const inflight = resolveCache.get(slug);
    if (inflight) {
      options.onReuse?.("in-flight");
      return subscribe(slug, inflight, options.signal);
    }
  }

  const params = new URLSearchParams();
  if (options.force) params.set("force", "true");
  const query = params.toString();
  const url = `${API_BASE_URL}/api/v1/movies/${encodeURIComponent(slug)}/resolve-mp4${
    query ? `?${query}` : ""
  }`;

  const controller = new AbortController();
  const onStart = options.onStart;
  const promise: Promise<ResolveMp4Response | null> = (async () => {
    // 1 度だけリトライ可能。504 / ネットワーク (タイムアウト含む) のときに発火。
    let attempt = 0;
    while (true) {
      const slotKind = await acquireSlot(controller.signal, priority);
      if (!slotKind) return null; // 全 consumer abort
      let shouldRetry = false;
      let result: ResolveMp4Response | null = null;
      try {
        if (attempt === 0) {
          // HTTP fetch が実際に開始した瞬間に通知 (warm の `start` ログ用)。
          try {
            onStart?.();
          } catch {
            // ロギング失敗は無視。
          }
        }
        const res = await fetch(url, {
          method: "GET",
          // クライアントから直接叩くため Next.js のキャッシュは無効。
          // 連打抑制はクライアント・サーバ両方の in-flight デデュープに任せる。
          cache: "no-store",
          // 全 consumer が abort されたら fetch も中断する。
          signal: controller.signal,
        });
        if (res.ok) {
          const data = (await res.json()) as ResolveMp4Response;
          if (data && typeof data.mp4_url === "string" && data.mp4_url) {
            result = data;
          }
        } else if (
          // 504 (Gateway Timeout) / 502 (Bad Gateway) はバースト由来の可能性が高い
          // ので 1 度だけリトライ。それ以外 (404 など) は即サムネ。
          (res.status === 504 || res.status === 502) &&
          attempt === 0
        ) {
          shouldRetry = true;
        }
      } catch {
        // ネットワークエラー / タイムアウト / abort
        if (!controller.signal.aborted && attempt === 0) {
          shouldRetry = true;
        }
      } finally {
        // sleep に入る前に必ずスロットを返し、他の slug がそのスロットを使えるようにする。
        releaseSlot(slotKind, priority);
      }

      if (!shouldRetry) return result;
      attempt += 1;
      await sleep(pickRetryDelayMs(), controller.signal);
      if (controller.signal.aborted) return null;
    }
  })();

  const entry: CacheEntry = { promise, controller, refCount: 0 };
  // force=true でも上書きしておく (これ以降の同一 slug 読み出しは新 URL を共有できる)。
  resolveCache.set(slug, entry);
  void promise.then((res) => {
    if (res && res.mp4_url) {
      // 成功は短期キャッシュへ昇格。in-flight 終了後の再要求でも即返せる。
      writeSuccessCache(slug, res);
    }
    // 失敗 (null) ケースはキャッシュから外す = 次回再試行できる。
    // 成功ケースは subscribe() 側の refCount=0 でクリーンアップされるが、
    // 念のため successCache に値が入っていれば in-flight エントリも片付ける。
    if (resolveCache.get(slug) === entry) {
      if (res === null) {
        resolveCache.delete(slug);
      } else if (res && res.mp4_url) {
        // 成功は successCache がカバーするので in-flight エントリは即お役御免。
        resolveCache.delete(slug);
      }
    }
  });

  return subscribe(slug, entry, options.signal);
}

/**
 * 共有 in-flight に consumer として subscribe する。
 *  - signal が abort されたら refCount を 1 減らし、0 になったら controller.abort()。
 *  - signal が無い consumer も 1 カウントされ、Promise 完了時に解放される。
 *  - signal が既に abort されていれば購読せず即 null。
 */
function subscribe(
  slug: string,
  entry: CacheEntry,
  signal: AbortSignal | undefined,
): Promise<ResolveMp4Response | null> {
  if (signal?.aborted) return Promise.resolve(null);

  entry.refCount += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      // 全 consumer が離脱 → 実 fetch を中断
      entry.controller.abort();
      if (resolveCache.get(slug) === entry) {
        resolveCache.delete(slug);
      }
    }
  };

  return new Promise<ResolveMp4Response | null>((resolve) => {
    const onAbort = () => {
      signal?.removeEventListener("abort", onAbort);
      release();
      resolve(null);
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    entry.promise.then((value) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      release();
      resolve(value);
    });
  });
}

/** テスト用にキャッシュをクリアする (本番コードからは呼ばない想定)。 */
export function __resetResolveCachesForTests(): void {
  resolveCache.clear();
  successCache.clear();
  waiters.length = 0;
  activeFetches = 0;
  activeLow = 0;
  activeHighBurst = 0;
}
