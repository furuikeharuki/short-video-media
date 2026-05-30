/**
 * 「現在再生中 (中央 active) の <video> がいま安定して再生できているか」を 1 箇所に
 * 集約する超軽量ストア。byte-prefetch (隠し <video preload="auto">) が active 動画の
 * 帯域を奪って再生を止めてしまう問題を防ぐために使う。
 *
 * 背景:
 *   - usePrefetchVideoBytes は current+1 / +2 / -1 の隠し <video> を
 *     preload="auto" でマウントし、ブラウザに先頭バッファ (Range request) を
 *     取りに行かせる。これは「次の動画の再生開始を速くする」ためには有効だが、
 *     モバイル Safari (同 origin 同時接続 4〜6) や HTTP/2 多重化下では、active
 *     <video> がまだ canplay に達していない / waiting・stalled に落ちている間も
 *     prefetch が走り続け、active の Range 取得と帯域を取り合って「現在見ている
 *     動画が止まる」症状を生む。
 *   - 既存の抑制トリガーは rapid swipe (isRapidSwiping) だけで、「ゆっくり 1 本に
 *     留まって見ているのに、その 1 本がバッファリングしている」ケースは拾えていない。
 *
 * 方針 (現在動画優先):
 *   - active <video> が "stable" (playing 観測済みで waiting/stalled に落ちていない)
 *     になるまで byte-prefetch を遅らせる = 帯域を active に集中させる。
 *   - playing が安定したら prefetch を解禁し、「次の 1〜2 本」の先読みを維持する。
 *   - active が waiting / stalled に落ちたら再び prefetch を抑制し、active の
 *     バッファ回復を最優先する。
 *
 * 注意:
 *   - resolve-mp4 (URL 解決) はバイトを取らない軽量処理で、別途 priority/同時実行
 *     制御が入っているのでここでは抑制対象にしない。抑制するのは「バイトを取りに行く
 *     隠し <video>」だけ。
 *   - この store は active <video> のイベント (playing / waiting / stalled / 非
 *     active 化) から FeedItem が更新する。prefetch hook は購読して再評価する。
 */

type PlaybackPhase = "idle" | "buffering" | "stable";

let phase: PlaybackPhase = "idle";
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* 個別リスナーのエラーは無視 */
    }
  }
}

function setPhase(next: PlaybackPhase): void {
  if (phase === next) return;
  phase = next;
  emit();
}

/**
 * active <video> が実際にフレームを進めている (playing) ことを通知する。
 * これ以降、byte-prefetch を解禁してよい状態 ("stable")。
 */
export function markActivePlaying(): void {
  setPhase("stable");
}

/**
 * active <video> が再生開始前 / waiting / stalled / error などで「まだ安定して
 * 再生できていない」ことを通知する。byte-prefetch は抑制して帯域を active に譲る。
 */
export function markActiveBuffering(): void {
  setPhase("buffering");
}

/**
 * active <video> が無い状態 (フィードを離れた / 中央スライドが動画でない 等) に
 * 戻す。prefetch 抑制も解除する (抑制すべき active が存在しないため)。
 */
export function markActiveIdle(): void {
  setPhase("idle");
}

/**
 * byte-prefetch を今は遅らせるべきか。
 * active が "buffering" (再生開始前 / バッファリング中) のときだけ true。
 * "stable" (安定再生中) や "idle" (active 動画なし) のときは false = prefetch 許可。
 */
export function shouldDeferPrefetch(): boolean {
  return phase === "buffering";
}

/** 現在の再生フェーズを取得する (デバッグ・テスト用)。 */
export function getActivePlaybackPhase(): PlaybackPhase {
  return phase;
}

/** 再生フェーズの変化を購読する。返り値で解除。 */
export function subscribeActivePlayback(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
