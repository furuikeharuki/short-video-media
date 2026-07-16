"use client";

import { useEffect, useLayoutEffect, useRef, useCallback, useState } from "react";

import { createVideoTimer, isVideoTimingEnabled } from "@/lib/videoTiming";
import {
  TAIL_KEEP_SEC,
  tailStartForDuration,
} from "@/lib/proActress";

const SKIP_SEC = 5;
const DBL_TAP_MS = 300;
const LONG_PRESS_MS = 500;
const TAP_MOVE_THRESHOLD = 10;
const PLAY_THRESHOLD = 0.85;

/**
 * 末尾スキップの再生開始秒数 (= スキップ下限) を live <video> から計算する。
 *
 * 旧仕様 (先頭 5 秒スキップ) は固定値だったが、新仕様は「末尾 60 秒だけ残す」=
 * `duration - 60` の duration 依存になったため、duration が読める
 * (readyState>=1) 状態でしか正しい値を出せない。duration 未確定や、動画が
 * 60 秒以下 (= 丸ごと再生) のときは 0 (スキップ無効) を返す。
 */
function tailSkipLowerBoundFor(video: HTMLVideoElement, tailSkip: boolean): number {
  if (!tailSkip) return 0;
  return tailStartForDuration(video.duration, TAIL_KEEP_SEC);
}

let globalUserGestured = false;
let globalIsMuted = true;
let didCheckStartUnmutedFlag = false;

// ショートボタンを押して遷移してきたケース (sessionStorage.feed_start_unmuted=1) だけは
// そのクリックをユーザージェスチャーとみなして音声 ON で起動する。一回使ったらフラグは消す。
function consumeStartUnmutedFlag(): boolean {
  if (didCheckStartUnmutedFlag) return false;
  didCheckStartUnmutedFlag = true;
  if (typeof window === "undefined") return false;
  try {
    const flag = sessionStorage.getItem("feed_start_unmuted");
    if (flag === "1") {
      sessionStorage.removeItem("feed_start_unmuted");
      globalUserGestured = true;
      globalIsMuted = false;
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

// FeedViewer のスワイプ操作など、表示するスライドが変わったときに呼ばれ、
// 「この遷移はユーザー操作によるもの」と明示的にマークして unmuted 再生を許す。
export function markFeedGesture(): void {
  globalUserGestured = true;
}

interface UseFeedPlaybackOptions {
  slug: string;
  title: string;
  isActive: boolean;
  /**
   * 現在マウントされている <video> の src。
   * resolver で遅延取得されたケース、isActive=true になった時点では
   * まだ <video> がマウントされていないため、isActive だけを deps にしても
   * playVideo が呼ばれない。videoSrc を deps に含めることで
   * <video> マウント直後に一度 effect を再実行させ、自動再生を起動させる。
   * null の間 (resolver 待ちや exhausted) は <video> がそもそも存在しない。
   */
  videoSrc: string | null;
  /**
   * handoff promote で host に append された <video> 要素。null の間は通常の
   * JSX `<video>` がマウントされており videoRef は React 側で設定される。
   * non-null になったタイミングで videoRef.current が promoted 要素に差し替わる
   * ため、active-autoplay effect の deps に含めて再走させ、自動再生を再起動する。
   */
  boundElement?: HTMLVideoElement | null;
  onOpenModal: (slug: string) => void;
  /**
   * 末尾スキップを適用するかどうか。現在は全動画で true。
   * true のとき「末尾 60 秒 (= 1 分) だけ残して手前を全部スキップ」する。
   * 開始位置 (= 下限 lower) = duration - TAIL_KEEP_SEC。
   *   - 初回再生時に currentTime を lower にセットして開始
   *   - -5s スキップで currentTime < lower にならないようクランプ
   *   - video-seek (シークバー) も下限 lower でクランプ
   *   - timeupdate / seeking で currentTime < lower を検知したら強制的に lower に戻す
   *   - 再生終了 (ended) でループするときも lower から再開
   * ただし開始位置は duration 依存のため loadedmetadata 確定後にしか計算できない。
   * duration <= 60 秒の場合は丸ごと再生 (スキップ無効)。
   */
  isProActress?: boolean;
  /**
   * force-fallback が発火するたびにインクリメントされるカウンタ。FeedItem の
   * `fallbackEpoch` 状態と一致。autoplay / pro-actress / 各 watchdog の effect の
   * deps に含めることで、`<video>` が remount された commit で確実に effect が
   * 再走し、attemptActiveAutoplay("force-fallback") 等で新要素に対する
   * src 確認 / load() / play() の再起動が行われるようにする。
   */
  fallbackEpoch?: number;
}

export function useFeedPlayback({ slug, title, isActive, videoSrc, boundElement = null, onOpenModal, isProActress = false, fallbackEpoch = 0 }: UseFeedPlaybackOptions) {
  // 初回マウント時に一回だけショートボタンフラグを消費
  consumeStartUnmutedFlag();

  const videoRef     = useRef<HTMLVideoElement>(null);
  const sectionRef   = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shimmerRef   = useRef<HTMLDivElement>(null);
  const spinnerRef   = useRef<HTMLDivElement>(null);
  const fastBadgeRef = useRef<HTMLDivElement>(null);
  const overlayRef   = useRef<HTMLDivElement>(null);
  const rafRef       = useRef<number | null>(null);
  const isActiveRef  = useRef(false);

  const isPlayingRef             = useRef(false);
  // この <video> インスタンスで一度でも playing イベントが発火したかどうか。
  // 現在は主に「初回ロード完了後に shimmer タイマーをリセットしない」等の状態追跡用。
  // videoSrc が変わったとき (= 新しい作品に切り替わったとき) はリセット。
  const hasPlayedRef             = useRef(false);
  // スピナー表示を一定時間遅らせるためのタイマー ID。
  // waiting/stalled が短時間で解消する (= playing がすぐ来る) ようなケースで
  // スピナーがチラッと見えてしまうのを防ぐ。setSpinnerVisible(false) でクリアされる。
  const spinnerShowTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMutedRef               = useRef(globalIsMuted);
  const tapTimerRef              = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapCountRef              = useRef(0);
  const tapStartPosRef           = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const longPressTimerRef        = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLongPressRef           = useRef(false);
  const wasLongPressJustEndedRef = useRef(false);
  const isTouchDeviceRef         = useRef(false);
  const lastTouchEndRef          = useRef(0);
  const pcClickCountRef          = useRef(0);
  const pcClickTimerRef          = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isMuted,      setIsMuted]      = useState(globalIsMuted);

  // プロ女優スキップを適用すべきかどうかを ref に保持。<video> ごとの動的判定で、
  // メタデータロード後に duration を見て確定する (短すぎる動画は無効化)。
  const skipEffectiveRef = useRef(false);
  // プロ女優スキップ用の最小許容秒数。skipEffectiveRef が false なら 0。
  const skipLowerBoundRef = useRef(0);
  // プロ女優判定の最新値を ref に同期。playVideo は useCallback で deps を絞っていて
  // 再生成したくないので、ref 経由で最新の isProActress を読めるようにしておく。
  // 初期値を prop から取ることで、初回 active mount (autoplay が最初に走る前) でも
  // 末尾スキップ判定を取り逃がさない。以降の変化は下の useLayoutEffect で同期する。
  const isProActressRef = useRef(isProActress);

  // 同 slug 作品で「直近の再生位置」を記憶しておく ref。
  // 再生中に <video> が onError → force リトライで src が差し替わったときに、
  // 新しい <video> の loadedmetadata タイミングで currentTime をこの位置に戻して
  // 「リトライしても最初から再生しない」を実現する。
  // slug が変わった (新しい作品にスワイプ) ときは time を 0 にリセット。
  const lastPlaybackRef = useRef<{ slug: string; time: number }>({ slug: "", time: 0 });

  // 画質切替 (低→高 upgrade / 高→低 downgrade) 専用の resume 位置。
  // 切替で <video> の src が差し替わると currentTime が 0 に戻るため、切替直前に
  // ここへ再生位置を退避しておき、新 src の loadedmetadata で同位置へ seek し直す。
  // これにより「画質を切り替えると最初から再生になる」のを防ぐ。
  // lastPlaybackRef とは別に持つ理由: src 差し替え直後に rs=0 の <video> から
  // currentTime=0 の timeupdate が漏れて lastPlaybackRef を 0 に上書きするレースが
  // あるため、切替 resume は専用 ref で確実に保持・消費する。
  const qualitySwitchResumeRef = useRef<{ slug: string; time: number } | null>(null);

  // ユーザーが明示的にポーズしたかどうか。fireTogglePlay の pause / handleDetail (modal 開く)
  // で true、playVideo / modal-close での再開で false に戻す。
  // pro-actress minStart の seek 後 play() リトライで「ユーザーが止めた動画を勝手に再生再開しない」
  // ためのガード。
  const userPausedRef = useRef(false);
  // pro-actress minStart enforce で seek した直後、active かつ paused なら 1 回だけ play() を
  // 再試行するためのフラグ。seeked → (必要なら canplay) で消費する。
  // - true: 次の seeked / canplay で play retry をスケジュール
  // - false: リトライ不要 (= まだ enforce していない / すでにリトライ済み)
  // 同じ seek イベントで二重に発火させないため、リトライ実行時 / イベント受領時に即座に false に戻す。
  const proActressPlayRetryPendingRef = useRef(false);
  // play retry が「resolve したが playing が来ない」場合の最終フォールバック用 timer。
  // 1 回だけ video.play() を直接呼び直す。ループ防止のため使用後に必ず null に戻す。
  const proActressPlayFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 戻りスワイプ (back-swipe) 後の promote で readyState=0 のまま play() が
  // promise pending のまま canplay/playing も来ず黒画面+スピナーで止まるケースの
  // 救済用 watchdog timer。
  //
  // 背景: 順方向に再生 (8→9→10) してから 1 つ戻る (10→9) と、FeedItem 9 は
  // adjacent の間 isActive=false で video.pause() が走り待機状態に入る
  // (currentTime は playhead resume のため温存)。Chrome は背景の <video> の
  // メディアバッファを memory pressure や inactive 経過時間で破棄するため、
  // 戻ったとき promoted 要素の readyState が 0 まで落ちていることがある。この状態で attemptActiveAutoplay
  // が play() を呼んでも canplay まで待たされ、何らかの理由 (Range request が
  // 遅延 / blocked / loadeddata 来ない) で永久 pending になる事例が観測された。
  //
  // 対策 (2 段構え):
  //   Phase 1 (ACTIVE_AUTOPLAY_WATCHDOG_MS = 1500ms):
  //     play() を発火した瞬間に watchdog を 1 本だけ仕掛け、経過しても paused の
  //     ままなら 1 回だけ video.load() してから直接 play() を呼び直す。これにより
  //     HTMLMediaElement 側の internal state を強制リセットし、Range request を
  //     最初から発行させる。
  //   Phase 2 (ACTIVE_AUTOPLAY_STUCK_MS = 3500ms 総):
  //     Phase 1 の load()+play() でも readyState 0 のまま動かない (= 署名 URL が
  //     セッション復帰後に期限切れ / CDN コネクションが完全に切断された等) ケースの
  //     最終救済として `video-active-stuck` カスタムイベントを window に
  //     dispatch する。FeedItem 側がこれを購読し、useResolvedVideoSrc.handleError
  //     経由で force re-resolve を起こし、新 URL を videoSrc に反映する。新 URL は
  //     後段 effect で promoted 要素の src に再バインドされ、load() で再生開始する。
  // active session 1 回につき 各 phase 1 回だけ発火 (active 化のたびに ref を
  // false に戻す)。
  const activeAutoplayWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeAutoplayRecoveredRef = useRef(false);
  const activeAutoplayStuckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeAutoplayStuckSignaledRef = useRef(false);
  // Phase 0 (load-kick) watchdog: promote 直後の force-load 単発 `video.load()` が
  // ブラウザ内部の状態 race (= src attached だが Range request が立ち上がらない、
  // networkState=NETWORK_EMPTY/NO_SOURCE のまま固まる) で no-op になるケースを、
  // Phase 1 (1500ms) より早い段階で検知して hard-reset を撃つ。
  // 1 active session につき 1 度だけ発火 (load-kick ref が立ったらこの session では
  // 再 arm しない)。
  const activeAutoplayLoadKickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeAutoplayLoadKickedRef = useRef(false);
  // Phase 2 loading-grace timer: Phase 2 (3500ms) 到達時点で
  // rs=0 / networkState=NETWORK_LOADING(2) / no error / currentTime=0 のときは、
  // ブラウザがまさに Range request 中で metadata 未到達のため `video-active-stuck`
  // dispatch (= sameUrl force-resolve + recovery) は害になる (in-flight load を
  // AbortError で kill して逆に latency が悪化する)。Phase 2 で即 dispatch せず、
  // この grace timer (= Phase 2 から追加で ACTIVE_AUTOPLAY_LOADING_GRACE_MS) を
  // 武装し、依然として進捗無し (rs=0 のまま) であれば本当に死んでいると判定して
  // recovery を発火する。1 active session につき 1 回だけ arm する。
  const activeAutoplayLoadingGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeAutoplayLoadingGraceArmedRef = useRef(false);
  // この active session で playing イベントを 1 度でも観測したか。
  //
  // HTML5 仕様上 video.play() は呼んだ瞬間に video.paused=false にセットされる
  // (Promise が pending のままでも) ため、watchdog の `if (!video.paused) return`
  // ガードは「play() を呼んだ」だけで満たされてしまい、実体は rs=0 buffer 待ちで
  // 1 フレームも進んでいないケースで Phase 1 / Phase 2 watchdog が両方とも
  // 何のログも残さずサイレント no-op していた。本フラグは playing イベントで
  // のみ true にし、watchdog 内では「本当に再生開始したか」を paused ではなく
  // これで判定する。isActive=false / unmount でリセット。
  //
  // 加えて、watchdog 発火時に「currentTime が arm 時点より進んでいる」or
  // 「play() promise が resolve して rs>=3 になっている」も「実質再生中」として
  // この ref を立てる。playing イベントは Chrome では canplay → playing の順で
  // 並ぶが、handler attach タイミング (effect 再走 / boundElement rebind) によって
  // 1 回 lost するケースがあり、その結果 playing 観測 false のまま rs=4 で動く
  // 動画に対して Phase 1 が load() を撃ってしまい playback を kill していた。
  const activePlayingObservedRef = useRef(false);
  // watchdog のセッション識別子。attemptActiveAutoplay で新規に arm するたびに
  // インクリメントし、setTimeout クロージャはこの値をキャプチャする。発火時に
  // 現在値と一致しなければ「もう古い attempt」とみなして bail。これにより、
  // 「resolve 済みの古い session の watchdog が、後の rebind/promote の途中で
  // 発火して playback を kill する」race を防ぐ。
  const activeAutoplayAttemptIdRef = useRef(0);
  // 「最後に stuck signal を dispatch した時刻」を slug 単位で記録する。
  // 同一 slug に対して短時間 (STUCK_COOLDOWN_MS) 内に複数回 stuck signal が出ると、
  // 同じ URL に対する force-resolve が連発して状態が変わらないまま無限ループに
  // なりうるので、cooldown 中は dispatch を抑制する。
  const lastStuckSignalRef = useRef<{ slug: string; at: number }>({ slug: "", at: 0 });

  // pro-actress 用の seek deadline。grace 内に seeked が来なければ flag を落とす。
  // 値は arm 時の slug をキャプチャするので閉路で OK。
  const PRO_ACTRESS_SEEK_DEADLINE_MS = 2500;

  // pro-actress 開始位置 (duration-60) への seek が「飛行中」かどうか。
  //
  // 背景: handoff promote で claim した <video> 要素は registry 上 readiness=canplay
  // (rs>=3) で渡ってくることが多いが、active 化時点で currentTime=0 のため
  // attemptActiveAutoplay が pro-actress enforce で currentTime=0 -> 開始位置 の seek を
  // 撃つ。seek 先 (開始位置) のフレームがまだバッファに無いと、Chrome は seeking
  // 直後 readyState を rs=1 (HAVE_METADATA) まで落とし、開始位置周辺のデータが
  // 揃うまで rs を戻さない。これは仕様どおりの一時的な再バッファであり「stuck」
  // ではないが、現状の Phase 1 watchdog (1500ms 経過 & playing 未観測 & paused)
  // からは区別できず、誤って load() を撃って canplay 済みバイトを破棄する事故を
  // 起こしていた。
  //
  // フラグの動き:
  //   - 立てる: attemptActiveAutoplay で「pro-actress enforce before autoplay」
  //     としての seek を撃った直後。recovery 経路の `target.currentTime = 5` でも
  //     立てる。
  //   - 落とす: 当該 <video> 上で `seeked` を 1 度観測 (= seek 完了)、または
  //     playing を観測、または非 active 化 / userPause / slug 変更。
  //   - watchdog 内ガード: in-flight の間は Phase 1 / Phase 2 を「stuck」とみなさず、
  //     bail=pro-actress-seek として再 arm せずに次の seeked 待ちに委ねる。
  //
  // 「永遠に in-flight のまま seeked が来ない死 element」の保険として、
  // PRO_ACTRESS_SEEK_DEADLINE_MS 経過したら自動的に flag を落とす。これにより
  // 真の stuck (seek 先のバイトが永久に来ない) ケースは従来通り Phase 2 で救済可能。
  const proActressSeekInFlightRef = useRef(false);
  const proActressSeekDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // active autoplay intent の保留状態。
  //
  // 「active 化したが videoRef.current がまだ null (= 要素が bind されていない)」
  // ケースでは attemptActiveAutoplay は no-element で defer するだけだが、後で
  // boundElement / videoSrc が変わって effect が再走しても、useEffect commit 内で
  // videoRef.current が時間順に null → non-null になる微小な race
  // (FeedItemVideo の useLayoutEffect で host.appendChild + videoRef.current 設定
  // が走るタイミング、または handoff promote 直後にもう一度 React の commit を経る
  // ケース) で、ref が確定する前に early return → 二度と attempt されないことがある。
  //
  // この pending intent は「現 slug / videoSrc に対する autoplay を起動したい」を
  // 持ち越すための ref で、以下のいずれかで消費する:
  //   - boundElement が non-null になった直後の queueMicrotask
  //   - canplay / loadeddata / loadedmetadata イベント
  //   - readiness ベースのセーフティネット effect の同期チェック
  // 以下のいずれかで破棄する:
  //   - isActive=false / userPaused / detail open
  //   - slug / videoSrc 変更
  //   - unmount
  //   - 一度実行 (成否に関わらず) して消費
  // フィールドに slug/videoSrc を持たせて stale intent を弾く。
  const pendingActiveAutoplayRef = useRef<
    | { slug: string; videoSrc: string }
    | null
  >(null);

  // pro-actress 用 minStart seek を「飛行中」マークする。watchdog はこのフラグを
  // 見て、まだ seek 中の rs=1 を stuck 扱いしない。seeked / 非 active / userPause /
  // unmount / deadline で確実に解除する。
  const clearProActressSeekInFlight = useCallback(() => {
    if (proActressSeekDeadlineRef.current != null) {
      clearTimeout(proActressSeekDeadlineRef.current);
      proActressSeekDeadlineRef.current = null;
    }
    proActressSeekInFlightRef.current = false;
  }, []);
  const markProActressSeekInFlight = useCallback(() => {
    proActressSeekInFlightRef.current = true;
    if (proActressSeekDeadlineRef.current != null) {
      clearTimeout(proActressSeekDeadlineRef.current);
    }
    const armDeadline = () => {
      proActressSeekDeadlineRef.current = setTimeout(() => {
        proActressSeekDeadlineRef.current = null;
        // Deadline 到達時点で「seek 先 (minStart) には居る / 居る付近で
        // networkState=NETWORK_LOADING(2) で再バッファ継続中 / hasError=false」
        // のときは、これは仕様どおりの一時的な再バッファであり真の stuck では
        // ない。in-flight フラグを落とすと Phase 2 watchdog が rs=1
        // networkState=2 currentTime=minStart を stuck とみなして
        // `video-active-stuck` を dispatch し、URL force-resolve + recovery
        // 経路で再 load が走って delayed seeked が stale-element 化する事故が
        // 起きる。ここでは flag を維持して deadline を延長する。
        // 真の死 element (rs=0 / networkState=EMPTY|NO_SOURCE / error) や、
        // 「seek 先にまだ到達していない & networkState も止まっている」場合
        // は従来通り flag を落として watchdog の通常経路に委ねる。
        const video = videoRef.current;
        const lower = skipLowerBoundRef.current;
        const reachedMinStart =
          !!video &&
          lower > 0 &&
          video.currentTime + 0.05 >= lower;
        // 既に再生に乗っている (rs>=HAVE_FUTURE_DATA かつ paused=false、または
        // playing イベント観測済みで paused=false) ケースでは、networkState=2 は
        // ただの先読みであって rebuffer ではない。ここで extend を続けると
        // in-flight flag が再生中もずっと立ったままになり、後段の watchdog や
        // recovery 経路から見て紛らわしいので、明示的に flag を落とす。
        const effectivelyPlaying =
          !!video &&
          !video.paused &&
          (video.readyState >= 3 || activePlayingObservedRef.current);
        if (effectivelyPlaying) {
          proActressSeekInFlightRef.current = false;
          if (isVideoTimingEnabled()) {
            // eslint-disable-next-line no-console
            console.debug(
              `vt ${slug}: pro-actress seek in-flight cleared reason=playing-effective rs=${video!.readyState} networkState=${video!.networkState} currentTime=${video!.currentTime.toFixed(2)}`,
            );
          }
          return;
        }
        // 真の rebuffer (rs<HAVE_FUTURE_DATA で minStart 到達済み・error なし)
        // に限り deadline を延長する。rs>=3 は除外して再生中の churn を防ぐ。
        const stillLoading =
          !!video &&
          video.networkState === 2 &&
          video.error === null &&
          video.readyState >= 1 &&
          video.readyState < 3;
        if (
          isActiveRef.current &&
          !userPausedRef.current &&
          reachedMinStart &&
          stillLoading
        ) {
          if (isVideoTimingEnabled()) {
            // eslint-disable-next-line no-console
            console.debug(
              `vt ${slug}: pro-actress seek deadline extend reason=loading-at-minStart rs=${video.readyState} networkState=${video.networkState} currentTime=${video.currentTime.toFixed(2)}`,
            );
          }
          armDeadline();
          return;
        }
        proActressSeekInFlightRef.current = false;
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: pro-actress seek in-flight cleared reason=deadline`,
          );
        }
      }, PRO_ACTRESS_SEEK_DEADLINE_MS);
    };
    armDeadline();
  }, [slug]);

  // active 要素を強制的に再ロードさせる hard-reset。
  //
  // 単純な `video.load()` は、Chrome / Safari の HTMLMediaElement 内部状態 race
  // (= src attached だが Range request が立ち上がらない、networkState=EMPTY/NO_SOURCE
  // のまま固まる) で no-op になるケースがある。これは特に「prefetch buffer に
  // 居た要素を host へ adopt した直後」「戻りスワイプ後の rebind 直後」など、
  // 要素が DOM ツリーをまたいで移動した際に観測される。
  //
  // hard-reset 手順 (recovery 経路の sameUrl=true / stuckLow と同じ):
  //   1. video.pause() で play() promise の中断を確定させる。
  //   2. removeAttribute("src") + load() で element 状態をリセット。
  //   3. src を再代入 + load() で新規 Range request を発行する。
  //
  // 注意: AbortError ループを誘発しないよう「進行中の load() があるとき」(=
  // networkState=NETWORK_LOADING(2)) は呼出側でガードして呼ばないこと。
  const hardResetActiveLoad = useCallback(
    (video: HTMLVideoElement, label: string) => {
      const url = video.src || video.currentSrc;
      if (!url) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: active load-kick skip reason=no-src label=${label}`,
          );
        }
        return;
      }
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slug}: active load-kick start label=${label} rs=${video.readyState} networkState=${video.networkState}`,
        );
      }
      try { video.pause(); } catch { /* ignore */ }
      try { video.removeAttribute("src"); } catch { /* ignore */ }
      try { video.load(); } catch { /* ignore */ }
      try { video.src = url; } catch { /* ignore */ }
      try { video.load(); } catch { /* ignore */ }
    },
    [slug],
  );

  // slug が変わったら lastPlaybackRef をリセット。同じ <video> 上で src が差し替わる force リトライのときだけ
  // 以前の位置を保持したいため、videoSrc 変化ではリセットしないことに注意。
  // 保留 autoplay intent も slug 変更で破棄する (前作品の intent が新 slug に持ち越されない)。
  useEffect(() => {
    if (lastPlaybackRef.current.slug !== slug) {
      lastPlaybackRef.current = { slug: "", time: 0 };
    }
    // 別作品に切り替わったら画質切替 resume も破棄する (前作品の位置を持ち越さない)。
    if (qualitySwitchResumeRef.current && qualitySwitchResumeRef.current.slug !== slug) {
      qualitySwitchResumeRef.current = null;
    }
    const intent = pendingActiveAutoplayRef.current;
    if (intent && intent.slug !== slug) {
      pendingActiveAutoplayRef.current = null;
    }
  }, [slug]);

  useEffect(() => {
    const sync = () => {
      if (isMutedRef.current !== globalIsMuted) {
        isMutedRef.current = globalIsMuted;
        setIsMuted(globalIsMuted);
        const video = videoRef.current;
        if (video) video.muted = globalIsMuted;
      }
    };
    window.addEventListener("global-mute-change", sync);
    return () => window.removeEventListener("global-mute-change", sync);
  }, []);

  // 初回ロード中のサムネイル背景 (.shimmer) と、一時停止アイコンと同じ
  // .overlay-wrap 内で中央に表示されるローディングスピナー (.loading-spinner) は
  // 独立して制御する。そうしないとキャッシュ切れで再バッファーしたときに
  // スピナーだけ表示したいケースをサポートできない。
  //
  // 注: この関数は <video> の opacity のみ制御する。shimmer の表示制御は
  // setShimmerVisible で独立に行う (プリフェッチ済スライドでサムネが
  // 一瞬見えるチラつきを避けるため、shimmer は loadstart/loadedmetadata ベースで
  // 動かす)。
  const setVideoReady = useCallback((ready: boolean) => {
    const video = videoRef.current;
    if (video) video.style.opacity = ready ? "1" : "0";
  }, []);

  // shimmer (サムネ画像背景) の表示制御。
  //
  // 現在の設計では shimmer は「動画取得・再生がどうしてもできない状況 (onError)」
  // のフォールバックサムネとしてのみ使用される。
  // 通常のロード中は <video> の最初の 1 フレームが表示されたままスピナーだけが出る設計。
  const setShimmerVisible = useCallback((visible: boolean) => {
    const shimmer = shimmerRef.current;
    if (shimmer) shimmer.style.display = visible ? "block" : "none";
  }, []);

  // ローディングスピナーの表示・非表示を切り替える。
  // - 初回ロード中: サムネイル + スピナーを重ねて表示
  // - 再生中のバッファ不足 (waiting/stalled): スピナーのみ表示
  //
  // visible=true のときは即座に表示せず、SPINNER_SHOW_DELAY_MS だけ遅延させる。
  // これにより「200ms 以内に解決する一瞬の waiting」ではスピナーが見えず、
  // 本当に長引いたときだけスピナーが出る。
  // visible=false のときはタイマーをキャンセルし、即座に非表示。
  const SPINNER_SHOW_DELAY_MS = 250;
  const setSpinnerVisible = useCallback((visible: boolean) => {
    const el = spinnerRef.current;
    if (!el) return;
    if (visible) {
      // すでに表示要求が走っている / すでに表示済みなら何もしない
      if (spinnerShowTimerRef.current != null) return;
      if (el.style.display === "flex") return;
      spinnerShowTimerRef.current = setTimeout(() => {
        spinnerShowTimerRef.current = null;
        const cur = spinnerRef.current;
        if (cur) cur.style.display = "flex";
      }, SPINNER_SHOW_DELAY_MS);
    } else {
      if (spinnerShowTimerRef.current != null) {
        clearTimeout(spinnerShowTimerRef.current);
        spinnerShowTimerRef.current = null;
      }
      el.style.display = "none";
    }
  }, []);

  const showOverlay = useCallback((type: "play" | "pause") => {
    const el = overlayRef.current;
    if (!el) return;
    el.dataset.type = type;
    el.style.display = "flex";
    el.style.animation = "none";
    void el.offsetHeight;
    el.style.animation = "";
    setTimeout(() => { if (overlayRef.current) overlayRef.current.style.display = "none"; }, 700);
  }, []);

  const setFastBadge = useCallback((visible: boolean) => {
    const el = fastBadgeRef.current;
    if (el) el.style.display = visible ? "block" : "none";
  }, []);

  // 直近 dispatch した progress を記憶しておき、差分が無視できるほど小さいときは
  // dispatch しない。BottomNav のシークバーは ~0.1% 単位で十分滑らかに見えるので、
  // 毎フレーム同値を投げて BottomNav の setState を 60fps 走らせる必要はない。
  // これにより、useFeedPlayback の rAF と BottomNav の setProgress の組み合わせ
  // による「Maximum update depth exceeded」誤検知を避ける。
  const lastDispatchedProgressRef = useRef(-1);

  const startProgressLoop = useCallback(() => {
    const tick = () => {
      const video = videoRef.current;
      if (!video || !isActiveRef.current) {
        rafRef.current = null;
        return;
      }
      // プロ女優スキップ有効時はシークバーの 0% を「下限 (開始位置=duration-60) 目」に対応させる。
      // 進捗 = (currentTime - lower) / (duration - lower)。
      // 通常動画 (lower = 0) はこれまでと同じ currentTime / duration。
      const dur = video.duration;
      const lower = skipLowerBoundRef.current;
      let progress = 0;
      if (Number.isFinite(dur) && dur > lower) {
        progress = (video.currentTime - lower) / (dur - lower);
        if (progress < 0) progress = 0;
        else if (progress > 1) progress = 1;
      }
      // 0.001 (= 0.1%) 未満の変化では dispatch しない。
      // 終端 (1.0) / 始端 (0.0) ちょうどへの遷移は確実に通す。
      const last = lastDispatchedProgressRef.current;
      const reachedEdge =
        (progress === 0 && last !== 0) || (progress === 1 && last !== 1);
      if (reachedEdge || Math.abs(progress - last) >= 0.001) {
        lastDispatchedProgressRef.current = progress;
        window.dispatchEvent(new CustomEvent("video-progress", { detail: { progress } }));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const stopProgressLoop = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // アンマウント時に rAF を必ず止める。<video> 要素が外れたあとも tick が
  // 走り続けると video-progress を空 dispatch し続けて BottomNav 側で
  // 不必要な setState を生むため。
  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ ratio: number }>;
      const video = videoRef.current;
      if (!video || !isActiveRef.current) return;
      const dur = video.duration;
      if (!Number.isFinite(dur) || dur <= 0) return;
      // シークバー座標系も「0% = lower 秒目 / 100% = 末尾」に統一する。
      // ratio はシークバー左端=0, 右端=1 で送られてくるので、
      //   target = lower + ratio * (dur - lower)
      // これにより通常動画 (lower=0) は従来通り ratio * dur。
      const lower = skipLowerBoundRef.current;
      const usableSpan = Math.max(0, dur - lower);
      const ratio = Math.max(0, Math.min(1, ce.detail.ratio));
      const target = lower + ratio * usableSpan;
      // ユーザーが明示的にシークしたので、画質切替の sticky resume は破棄する
      // (ユーザー操作を上書きして勝手に元位置へ戻さない)。
      qualitySwitchResumeRef.current = null;
      try {
        video.currentTime = Math.min(dur, target);
      } catch {
        /* seek 不可能なタイミングは無視 */
      }
    };
    window.addEventListener("video-seek", handler);
    return () => window.removeEventListener("video-seek", handler);
  }, []);

  const playVideo = useCallback(async (video: HTMLVideoElement, withGesture = false) => {
    if (withGesture) globalUserGestured = true;
    // ユーザーがミュート解除済みかどうかは globalIsMuted をソースオブトルースにする。
    // そうしないと、「見た目は unmuted なのに video 要素だけ muted=true」などの不整合が起きる。
    video.muted = globalIsMuted;
    isMutedRef.current = globalIsMuted;

    // プロ女優スキップ (末尾 60 秒だけ残す) が有効、かつまだ開始位置より前にいるなら、
    // play() 直前に開始位置 (duration-60) へ飛ばす。
    // - 開始位置は duration 依存なので、duration が読めている (rs>=HAVE_METADATA)
    //   ときのみ確定値を出せる。skipLowerBoundRef.current (loadedmetadata 後に
    //   evaluate() で確定) を第一ソースにし、無ければ live duration から都度計算する。
    // - 旧・先頭 5 秒スキップと違い「固定の先読み seek」は使えない (duration 不明時は
    //   開始位置も不明)。duration 未確定のうちは seek せず、handleLoadedMeta ->
    //   enforceLowerBound に委ねる (metadata 到達後に確実に開始位置へ飛ぶ)。
    const lower = isProActressRef.current
      ? (skipLowerBoundRef.current > 0
          ? skipLowerBoundRef.current
          : tailSkipLowerBoundFor(video, true))
      : skipLowerBoundRef.current;
    if (lower > 0) {
      if (Number.isFinite(video.duration) && video.duration > lower) {
        if (video.currentTime < lower) {
          try { video.currentTime = lower; } catch { /* ignore */ }
        }
      } else if (Number.isFinite(video.duration) && video.duration > 0) {
        // duration が判明していて、かつ lower より短いケース (= 短すぎる動画)。
        // この場合スキップは無効化する (= currentTime はそのまま)。
      } else if (video.readyState >= 1) {
        // duration はまだ NaN だが少なくとも metadata は読めている (rs>=HAVE_METADATA)。
        // ブラウザによっては currentTime セットを silently accept する。失敗しても
        // handleLoadedMeta → enforceLowerBound で巻き取られる。
        try { video.currentTime = lower; } catch { /* ignore */ }
      } else {
        // rs=0: seek を撃つと「pending seek」内部状態だけが立ち、直後の load() で
        // それが暗黙 abort されて play() promise が AbortError で reject する race を
        // 誘発する (戻りスワイプ後の promote + watchdog 再武装で観測)。ここでは
        // 何もせず、loadedmetadata 後の enforceLowerBound に委ねる。
      }
    }

    try {
      await video.play();
      isPlayingRef.current = true;
      startProgressLoop();
      return;
    } catch {
      /* unmuted 再生に失敗したら muted フォールバックに進む */
    }

    // フォールバック: この <video> だけ muted=true にして再生を試みる。
    // ここで重要なのは globalIsMuted を書き換えないこと。
    // 以前は autoplay policy / 動画のないスライド / ロード失敗などで一時的に play() が
    // reject されると globalIsMuted=true に戻されてしまい、スクロールしているうちに
    // ミュートが勝手に ON に戻るバグがあった。
    // (globalUserGestured は markFeedGesture によってスワイプごとに再設定される、
    //  また handleToggleMute で明示的に unmute された状態は保持しておきたい)
    video.muted = true;
    try {
      await video.play();
      isPlayingRef.current = true;
      startProgressLoop();
    } catch {
      // muted + playsInline でも autoplay 拒否されたケース。
      // dev 計測中はログだけ残す (UI は使える状態のままにする)。
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(`vt ${slug}: autoplay blocked (muted fallback rejected)`);
      }
    }
  }, [startProgressLoop, slug]);

  // 詳細モーダルを閉じたとき、現在アクティブなスライドなら再生を再開する。
  // （handleDetail で video.pause() しているため、モーダルを閉じても video は paused のままになるため）
  useEffect(() => {
    const onModalClose = () => {
      const video = videoRef.current;
      if (!video) return;
      if (!isActiveRef.current) return;
      if (video.paused) {
        // モーダルを開いて閉じる一連のユーザー操作をジェスチャーとみなして unmuted 再生を試みる
        userPausedRef.current = false;
        playVideo(video, true);
      }
    };
    window.addEventListener("modal-close", onModalClose);
    return () => window.removeEventListener("modal-close", onModalClose);
  }, [playVideo]);

  // isActive を ref に同期させて、IntersectionObserver や modal-close / video-seek リスナーから
  // 最新の状態を参照できるようにする。
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // 親 (FeedViewer) で isActive=true になったタイミングで自動再生を試みる。
  // <video> 要素は isActive && videoSrc !== null のときだけマウントされるため、resolver
  // で URL を遅延取得したケースでも videoSrc を deps に含めることで、URL 到着・<video>
  // マウント直後に effect を再実行して自動再生を起動する。
  // 加えて、handoff promote で boundElement が後から差し替わるケースでも、
  // boundElement を deps に含めて effect を再走させて promoted 要素に対する play() を
  // 確実に呼ぶ。これが無いと「videoRef.current が null の commit で early return →
  // 直後の commit で videoRef が promoted 要素に書き換わるが effect 再走の契機が無い」
  // パスで autoplay が永久に走らない。
  //
  // attemptActiveAutoplay は active 化 / src 解決 / 要素 rebind / canplay / metadata の
  // どの経路で呼ばれても idempotent に「アクティブな <video> に対して 1 回 bounded
  // で play() を試みる」セマンティクスを提供する。abort / resolved / rejected を vt
  // ログに残す。
  const attemptActiveAutoplay = useCallback(
    (
      reason:
        | "active-change"
        | "promote"
        | "canplay"
        | "metadata"
        | "observer"
        | "element-bound"
        | "recovery"
        | "force-fallback",
    ) => {
      if (!isActiveRef.current) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(`vt ${slug}: active autoplay abort reason=inactive trigger=${reason}`);
        }
        return;
      }
      const video = videoRef.current;
      if (!video) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(`vt ${slug}: active autoplay abort reason=stale-element trigger=${reason}`);
        }
        return;
      }
      if (userPausedRef.current) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(`vt ${slug}: active autoplay abort reason=user-paused trigger=${reason}`);
        }
        return;
      }
      // 「already-playing」は paused=false 単独では判定しない。
      // HTML5 video.play() は呼んだ瞬間に paused=false を立てる (Promise pending でも)
      // ため、recovery 経路では「前 attempt の play() 呼び出し後 → rs=0 のまま buffer
      // 待ちで実は 1 フレームも進んでいない」状態でも `!paused` が成立し、ここで
      // silent abort されて recovery 後の load()+play() が走らずに黒画面で固まる
      // (#207 で watchdog 側は同類の false-positive を潰したが、本エントリガードは
      // 残っており #209 後も recovery 経路で再現していた)。
      //
      // 「実質再生中」= playing イベント観測済み + rs>=HAVE_FUTURE_DATA(3) + paused=false。
      // 加えて currentTime が arm 直前値より進んでいるかは reason=recovery 経路では
      // 計測できない (recovery 直前に reload しているため) ので playing イベント観測を
      // 主シグナルとして扱う。
      const effectivelyPlaying =
        !video.paused &&
        video.readyState >= 3 &&
        !video.ended &&
        activePlayingObservedRef.current;
      if (effectivelyPlaying) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: active autoplay abort reason=already-playing trigger=${reason} rs=${video.readyState} effectivePlaying=true`,
          );
        }
        return;
      }
      // recovery / promote 以外で paused=false なら従来通り abort する (canplay/metadata
      // ハンドラから保険で呼ばれた場合に、すでに play() 進行中の playback を kill しない)。
      // recovery / promote は「明示的に再起動したい」コンテキストなので、paused=false でも
      // rs<3 なら override して進む (下記 force-load + play() に到達させる)。
      if (!video.paused && reason !== "recovery" && reason !== "promote") {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: active autoplay abort reason=already-playing trigger=${reason} rs=${video.readyState} effectivePlaying=false`,
          );
        }
        return;
      }
      if (!video.paused && (reason === "recovery" || reason === "promote") && isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slug}: active autoplay override paused=false trigger=${reason} rs=${video.readyState} networkState=${video.networkState} reason=force-restart`,
        );
      }
      // MediaError 状態を持ち越したまま中央にスワイプしてきた <video> は、play() が
      // reject されるだけで再生できないので src を同じ URL で再ロードさせて
      // MediaError をリセットする (HTTP キャッシュから 206 で再利用される)。
      if (video.error !== null) {
        try { video.load(); } catch { /* ignore */ }
      }
      isMutedRef.current = globalIsMuted;
      setIsMuted(globalIsMuted);
      video.muted = globalIsMuted;
      // pro-actress 末尾スキップ (開始位置=duration-60) は「どの autoplay 経路でも play() より前に
      // currentTime を下限 (=5) に飛ばしておく」が単一の不変条件。
      // attemptActiveAutoplay は active-change / promote / canplay / metadata /
      // observer / element-bound のすべての autoplay 起動口になっているため、
      // ここで enforce しないと、特に handoff promote 直後 (rs=4 / currentTime=0)
      // で metadata / loadedmetadata イベントが新しい host 側では再発火せず、
      // enforceLowerBound() も走らないまま t=0 から再生開始してしまう。
      // playVideo 経由なら同様の seek が入るが、attemptActiveAutoplay は
      // resolve/reject を観測したい都合で video.play() を直接呼んでおり、
      // その直前にここで明示 seek する必要がある。
      //
      // ただし readyState=0 (= HAVE_NOTHING、loadedmetadata 前) では seek を
      // 走らせない。理由:
      //   - duration が NaN なので seek 自体が無効ターゲット扱いになり、
      //     ブラウザ内部に「pending seek」フラグだけが立つ。
      //   - 直後に needForceLoad=true で video.load() を呼ぶと、その pending seek
      //     が暗黙的に abort される。同時に直前の play() promise が
      //     "The play() request was interrupted by a new load request" で reject
      //     される loop に入りやすい (戻りスワイプで promote 直後のケースで観測)。
      //   - rs>=1 になったあと handleLoadedMeta -> enforceLowerBound +
      //     proActressPlayRetryPendingRef で巻き取られるので、ここで seek しなくても
      //     開始位置未満から再生開始することは無い (canplay/playing は metadata 後にしか
      //     来ない)。
      // 末尾スキップ仕様: 開始位置 = duration-60。duration が読める (rs>=1) ときのみ
      // 確定値を計算できるので、rs>=1 で開始位置>0 かつ currentTime が開始位置未満の
      // ときだけ seek する。rs=0 (duration 不明) は defer。
      const proLowerForAutoplay =
        isProActressRef.current && video.readyState >= 1
          ? tailSkipLowerBoundFor(video, true)
          : 0;
      if (
        isProActressRef.current &&
        video.readyState >= 1 &&
        proLowerForAutoplay > 0 &&
        video.currentTime + 0.05 < proLowerForAutoplay
      ) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: pro-actress enforce before autoplay currentTime=${video.currentTime.toFixed(2)} -> ${proLowerForAutoplay.toFixed(2)} reason=${reason} rs=${video.readyState}`,
          );
        }
        // seek を撃つ前に in-flight flag を立てる。watchdog はこの flag を
        // 見て「stuck」誤判定を抑える。seeked / inactive / unmount で解除される。
        markProActressSeekInFlight();
        try { video.currentTime = proLowerForAutoplay; } catch { /* ignore */ }
        // seek が反映されない / play() 開始時点で 0 から再生 になるケースの保険として
        // 既存の seeked / canplay リトライ経路を起動しておく。enforceLowerBound() と
        // 同じ ref を立てるだけで、tryConsumePlayRetry が play retry を引き受ける。
        proActressPlayRetryPendingRef.current = true;
      } else if (
        isProActressRef.current &&
        video.readyState === 0
      ) {
        // rs=0 ケース: duration 不明で開始位置を計算できないので、自前で seek は
        // 撃たず loadedmetadata 後の enforceLowerBound に委ねる。enforce が走った
        // 時点で play retry も pending 化されるので、metadata 到達後に自動的に
        // 開始位置 (duration-60) + play() が回る。
        proActressPlayRetryPendingRef.current = true;
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: pro-actress enforce deferred reason=${reason} rs=0 (wait for loadedmetadata)`,
          );
        }
      }
      // back-swipe 起因の promote で readyState=0 のままになっているケースを
      // 検知して、明示的に video.load() を 1 度だけ呼んで Range request を再
      // キックする。これが無いと、Chrome の HTMLMediaElement は内部的に「src
      // attached だが load() 未呼び出し」状態のまま play() を待たせ続けるケース
      // (戻りスワイプで bufferer がリセット) で永久 pending になる。
      // promote 以外の reason ではこの状況は起きないため (active-change は新規
      // <video> マウントで src 直設定なので React が load() を発火) promote だけ
      // 対象にする。
      // recovery 経路では networkState が NO_SOURCE(3) かつ rs=0 のときだけ load() を
      // 撃ち直す。それ以外の「rs>=HAVE_METADATA で networkState=IDLE/LOADING」状態は、
      // recoverActiveAfterForceResolve が直前に load() を呼んで loadedmetadata まで
      // 進んだ「成功直後」のシグナルである。そこで再 load() を呼ぶと:
      //   - rs を 0 にリセット
      //   - もう一度 loadstart -> metadata まで戻る
      //   - 直前の play() promise を AbortError で reject
      // という net negative になり、観測ログでも実際に backward 戻りで「recovery
      // force-load -> rs=0 -> もう一度 metadata+canplay 待ち -> +4s 再生開始」が
      // 起きていた。
      //
      // promote 経路は従来通り「rs=0 (= prefetch buffer 経由でも metadata 未到達)」
      // のときのみ load() を撃つ。canplay 済み (rs>=3) で promote されたケースは
      // 何もしない (Range request は元の prefetch <video> がもう完了済み)。
      const needForceLoad =
        (reason === "promote" || reason === "recovery") &&
        !activeAutoplayRecoveredRef.current &&
        video.readyState === 0 &&
        (reason === "promote" ||
          video.networkState === 0 ||
          video.networkState === 3);
      if (needForceLoad) {
        // rs=0 のうち networkState も EMPTY(0)/NO_SOURCE(3) のときは、単純な
        // load() が no-op になる Chrome の race を観測しているため、最初から
        // hard-reset を撃って確実に Range request を立ち上げる。NETWORK_LOADING(2)
        // などで既に進行中の場合は触らない (interrupt loop を誘発する)。
        const stuckLoad =
          video.networkState === 0 || video.networkState === 3;
        const useHardReset = stuckLoad && (video.currentSrc || video.src);
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: active autoplay ${reason} force-load rs=${video.readyState} networkState=${video.networkState} hardReset=${useHardReset}`,
          );
        }
        if (useHardReset) {
          hardResetActiveLoad(video, "promote-force-load");
        } else {
          try { video.load(); } catch { /* ignore */ }
        }
      }
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slug}: active autoplay start reason=${reason} paused=${video.paused} rs=${video.readyState} muted=${video.muted} currentTime=${video.currentTime.toFixed(2)}`,
        );
      }
      // watchdog 武装。
      //
      // Phase 1 (1500ms): play() を呼んだまま playing が観測できない場合、
      //   1 回だけ video.load() + play() を呼び直す。
      // Phase 2 (3500ms): Phase 1 でも playing が観測できない場合、URL 起因と
      //   判定して force re-resolve シグナルを dispatch する。
      //
      // 重要: 「再生開始したか」は `video.paused` ではなく
      // `activePlayingObservedRef.current` で判定する。video.play() は呼んだ瞬間に
      // paused=false を set する (Promise pending のままでも) ため、paused チェック
      // は play() を呼んだ後では常に false で素通りしてしまい、Phase 1 / Phase 2 が
      // 両方ともサイレント no-op になっていた。
      //
      // ただし playing イベント単独では取りこぼしがある (handler attach タイミング /
      // rebind / promote race)。そこで bail 判定では以下を「実質再生中」とみなす:
      //   - activePlayingObservedRef (playing event)
      //   - currentTime が arm 時点より >0.05s 進んでいる (frame は出ている)
      //   - rs >= HAVE_FUTURE_DATA(3) かつ !paused (描画可能 + 一時停止していない)
      // これにより、rs=4 で動いている動画に Phase 1 が誤って load() を撃って
      // playback を kill するケースを防ぐ。
      //
      // 同 active session 内では recovered / signaled が立っていない限り、最初に
      // 武装したタイマーをそのまま使う (新しい reason で再 entry されるたびに
      // タイマーをリセットすると、metadata / canplay の連続発火で締切が延々と延び、
      // 結果として永久に発火しない race を防ぐため)。
      //
      // 加えて、attemptId をキャプチャして発火時に現在値と比較する。古い session の
      // 残骸 timer が新 session の playback を kill しないようにする。
      const watchdogVideo = video;
      // Phase 0 (load-kick): 600ms 経過しても rs=0 かつ networkState=EMPTY(0)/
      // NO_SOURCE(3) (= load() を呼んだのに Range request が立ち上がっていない)
      // ケースを早期検知して hard-reset を撃ち、Phase 1 (1500ms) / Phase 2
      // (3500ms) より前に loadstart を発生させる。
      const ACTIVE_AUTOPLAY_LOAD_KICK_MS = 600;
      const ACTIVE_AUTOPLAY_WATCHDOG_MS = 1500;
      const ACTIVE_AUTOPLAY_STUCK_MS = 3500;
      const needArmPhase0 =
        activeAutoplayLoadKickTimerRef.current == null &&
        !activeAutoplayLoadKickedRef.current &&
        !activeAutoplayRecoveredRef.current;
      const needArmPhase1 =
        activeAutoplayWatchdogRef.current == null &&
        !activeAutoplayRecoveredRef.current;
      const needArmPhase2 =
        activeAutoplayStuckTimerRef.current == null &&
        !activeAutoplayStuckSignaledRef.current;
      // 新規に arm するときだけ attemptId を進める。再 entry (canplay 連発等) で
      // 既存タイマーがあるときは ID を維持して既存 timer の検証を有効に保つ。
      if (needArmPhase1 || needArmPhase2) {
        activeAutoplayAttemptIdRef.current += 1;
      }
      const armAttemptId = activeAutoplayAttemptIdRef.current;
      const armCurrentTime = video.currentTime;
      // 共通の「実質再生中」判定。
      const isEffectivelyPlaying = (v: HTMLVideoElement): boolean => {
        if (activePlayingObservedRef.current) return true;
        if (!v.paused && v.currentTime > armCurrentTime + 0.05) return true;
        if (!v.paused && v.readyState >= 3 && !v.ended) return true;
        return false;
      };
      if (needArmPhase0 && isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slug}: active autoplay watchdog armed phase=0 reason=${reason} rs=${video.readyState} networkState=${video.networkState} timeout=${ACTIVE_AUTOPLAY_LOAD_KICK_MS} attemptId=${armAttemptId}`,
        );
      }
      if (needArmPhase1 && isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slug}: active autoplay watchdog armed phase=1 reason=${reason} rs=${video.readyState} timeout=${ACTIVE_AUTOPLAY_WATCHDOG_MS} attemptId=${armAttemptId} t=${armCurrentTime.toFixed(2)}`,
        );
      }
      if (needArmPhase2 && isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slug}: active autoplay watchdog armed phase=2 reason=${reason} rs=${video.readyState} timeout=${ACTIVE_AUTOPLAY_STUCK_MS} attemptId=${armAttemptId} t=${armCurrentTime.toFixed(2)}`,
        );
      }
      // Phase 0 watchdog (load-kick): rs=0 / networkState=EMPTY|NO_SOURCE が
      // ACTIVE_AUTOPLAY_LOAD_KICK_MS 経過しても続いていたら、Range request が
      // 立ち上がっていない可能性が極めて高い。hard-reset を撃って次の loadstart
      // を確実に発生させる。Phase 1 より前に発火するため Phase 1 watchdog の
      // recovered latch には影響しない (loadKick 専用 ref で 1 セッション 1 回)。
      if (needArmPhase0) activeAutoplayLoadKickTimerRef.current = setTimeout(() => {
        activeAutoplayLoadKickTimerRef.current = null;
        const liveVideo =
          videoRef.current && videoRef.current.isConnected
            ? videoRef.current
            : watchdogVideo;
        let bail: string | null = null;
        if (armAttemptId !== activeAutoplayAttemptIdRef.current) bail = "stale-attempt";
        else if (!isActiveRef.current) bail = "inactive";
        else if (userPausedRef.current) bail = "user-paused";
        else if (!liveVideo) bail = "no-element";
        else if (activeAutoplayRecoveredRef.current) bail = "already-recovered";
        else if (activeAutoplayLoadKickedRef.current) bail = "already-kicked";
        else if (isEffectivelyPlaying(liveVideo)) {
          activePlayingObservedRef.current = true;
          bail = "playing-effective";
        }
        // pro-actress 0->5 seek 中は rs が一時的に 1 に落ちて当然なので
        // load-kick も抑止する。
        else if (proActressSeekInFlightRef.current) bail = "pro-actress-seek";
        // 既に rs>=1 まで進んでいる or networkState=LOADING(2) なら Range
        // request が走っているので load-kick は不要。
        else if (liveVideo.readyState >= 1) bail = `rs-ok=${liveVideo.readyState}`;
        else if (liveVideo.networkState === 2) bail = "loading";
        if (bail) {
          if (isVideoTimingEnabled()) {
            // eslint-disable-next-line no-console
            console.debug(
              `vt ${slug}: active autoplay watchdog bail phase=0 reason=${bail}`,
            );
          }
          return;
        }
        const target = liveVideo as HTMLVideoElement;
        activeAutoplayLoadKickedRef.current = true;
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: active autoplay load-kick fire reason=${reason} rs=${target.readyState} networkState=${target.networkState} same-el=${target === watchdogVideo}`,
          );
        }
        hardResetActiveLoad(target, "watchdog-phase0");
        // hard-reset 後は loadedmetadata / canplay が来た時点で
        // 後段の handleCanPlay / handleLoadedData セーフティネット effect が
        // attemptActiveAutoplay を呼び直すので、ここでは play() を撃たない。
        // 直接 play() を撃つと、上位 attemptActiveAutoplay の play() promise と
        // 競合して AbortError ループを誘発する。
      }, ACTIVE_AUTOPLAY_LOAD_KICK_MS);
      if (needArmPhase1) activeAutoplayWatchdogRef.current = setTimeout(() => {
        activeAutoplayWatchdogRef.current = null;
        // watchdog 起動時の bail 理由をすべてログに残す。silent no-op を防ぐ。
        // - 「play() で paused=false にされたが playing は未到達」を真の "stuck" として扱うため、
        //   paused チェックではなく activePlayingObservedRef.current === false を見る。
        // - videoRef.current が watchdogVideo と違っても、現要素 (= rebind 後の adopted
        //   要素) が同 active session で paused/未 playing ならそちらを救済対象にする。
        const liveVideo =
          videoRef.current && videoRef.current.isConnected
            ? videoRef.current
            : watchdogVideo;
        let bail: string | null = null;
        if (armAttemptId !== activeAutoplayAttemptIdRef.current) bail = "stale-attempt";
        else if (!isActiveRef.current) bail = "inactive";
        else if (userPausedRef.current) bail = "user-paused";
        else if (!liveVideo) bail = "no-element";
        else if (isEffectivelyPlaying(liveVideo)) {
          // playing event 未観測でも実体は動いているので observed フラグを立てて
          // 後続 (Phase 2 / 重複 arm) の誤発火を防ぐ。
          activePlayingObservedRef.current = true;
          bail = "playing-effective";
        }
        else if (activeAutoplayRecoveredRef.current) bail = "already-recovered";
        // pro-actress 用 0->5 seek 中は rs が一時的に 1 に落ちて当然なので
        // stuck 判定しない。seeked 受領で flag が落ちた後 / deadline 後の
        // 後続 watchdog (再 arm されないので実質次の active session) に委ねる。
        else if (proActressSeekInFlightRef.current) bail = "pro-actress-seek";
        // pro-actress enforce が `deferred reason=promote rs=0` で立てた
        // proActressPlayRetryPendingRef がまだ残ったまま metadata 到達 (rs>=1) した
        // ケース。loadedmetadata -> enforceLowerBound -> seeked ->
        // tryConsumePlayRetry が直後に走り再生再開するので、Phase 1 で load() を
        // 撃って pending な play() promise を AbortError reject させたり、
        // currentTime を 0 にリセットしたりしないようここで bail する。
        // rs=0 のときは metadata がまだ来ていないので、従来通り Phase 0/1 の load()
        // 救済を許す (本 bail には入らない)。
        else if (
          proActressPlayRetryPendingRef.current &&
          skipEffectiveRef.current &&
          skipLowerBoundRef.current > 0 &&
          liveVideo.readyState >= 1 &&
          liveVideo.currentTime + 0.05 < skipLowerBoundRef.current
        ) bail = "pro-actress-deferred-seek";
        // pro-actress minStart に到達した直後の「再バッファ継続中」状態は、
        // seek-in-flight deadline 後で flag が既に false でも stuck ではない。
        // rs in [1,2] (HAVE_METADATA / HAVE_CURRENT_DATA) かつ
        // networkState=LOADING(2) かつ currentTime>=minStart かつ no error の
        // ときは Phase 1 で load() を撃たず、進行中の Range request に委ねる。
        else if (
          skipEffectiveRef.current &&
          skipLowerBoundRef.current > 0 &&
          liveVideo.currentTime + 0.05 >= skipLowerBoundRef.current &&
          liveVideo.networkState === 2 &&
          liveVideo.readyState >= 1 &&
          liveVideo.readyState <= 2 &&
          liveVideo.error === null
        ) bail = "pro-actress-seek-loading";
        if (bail) {
          if (isVideoTimingEnabled()) {
            // eslint-disable-next-line no-console
            console.debug(
              `vt ${slug}: active autoplay watchdog bail phase=1 reason=${bail}`,
            );
          }
          return;
        }
        const target = liveVideo as HTMLVideoElement;
        activeAutoplayRecoveredRef.current = true;
        // load() を撃つかどうかは networkState で判定する。
        // - NETWORK_LOADING(2): 既に Range request が走っている。ここで load() を
        //   呼ぶと pending な play() promise が "interrupted by a new load request"
        //   で必ず reject され、追って再 play() するループになる。skip して play()
        //   だけ撃ち直す方が、現在のロードを継続できるので望ましい。
        // - NETWORK_EMPTY(0) / NETWORK_IDLE(1) / NETWORK_NO_SOURCE(3): 進捗が完全に
        //   止まっているので load() で Range request を発行し直す価値がある。
        const shouldReload = target.networkState !== 2;
        // networkState が EMPTY(0)/NO_SOURCE(3) かつ rs=0 のままなら、単純な
        // load() は no-op になることが分かっているので hard-reset (detach + load
        // + re-attach + load) を撃って Range request を確実に立ち上げる。
        // 既に load-kick で hard-reset 済みのケース (= activeAutoplayLoadKickedRef
        // が true) でも、Phase 1 到達ということは load-kick が効かなかったので
        // 念のためもう一度 hard-reset を試す。
        const needHardReset =
          shouldReload &&
          target.readyState === 0 &&
          (target.networkState === 0 || target.networkState === 3);
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: active autoplay watchdog recover reason=${reason} rs=${target.readyState} networkState=${target.networkState} reload=${shouldReload} hardReset=${needHardReset} currentTime=${target.currentTime.toFixed(2)} same-el=${target === watchdogVideo}`,
          );
        }
        if (needHardReset) {
          hardResetActiveLoad(target, "watchdog-phase1");
        } else if (shouldReload) {
          try { target.load(); } catch { /* ignore */ }
        }
        // load() 後は currentTime が 0 にリセットされうるので、pro-actress
        // 末尾スキップ (開始位置 = duration-60) enforce を再適用してから play() を呼ぶ。
        // 注意: rs=0 で seek すると「pending seek」だけが立って load() abort race を
        //       誘発するため、rs>=HAVE_METADATA(1) のときだけ seek する。rs=0 のときは
        //       metadata 到達後の handleLoadedMeta -> enforceLowerBound に委ねる。
        //       開始位置は duration 依存なので rs>=1 で live duration から計算する。
        if (isProActressRef.current && target.readyState >= 1) {
          const proLower = tailSkipLowerBoundFor(target, true);
          if (proLower > 0 && target.currentTime + 0.05 < proLower) {
            markProActressSeekInFlight();
            try { target.currentTime = proLower; } catch { /* ignore */ }
          }
        }
        target.muted = globalIsMuted;
        const p = target.play();
        if (p && typeof p.then === "function") {
          p.then(
            () => {
              if (isVideoTimingEnabled()) {
                // eslint-disable-next-line no-console
                console.debug(
                  `vt ${slug}: active autoplay watchdog resolved rs=${target.readyState}`,
                );
              }
            },
            (err: unknown) => {
              const e = err as { name?: string; message?: string } | null;
              if (isVideoTimingEnabled()) {
                // eslint-disable-next-line no-console
                console.debug(
                  `vt ${slug}: active autoplay watchdog rejected name=${e?.name ?? "Error"} message=${e?.message ?? String(err)}`,
                );
              }
              // muted fallback (1 回だけ)。watchdog 自身は二度目を仕掛けない。
              if (!isActiveRef.current) return;
              if (userPausedRef.current) return;
              const live = videoRef.current;
              if (!live) return;
              if (activePlayingObservedRef.current) return;
              void playVideo(live, false);
            },
          );
        }
      }, ACTIVE_AUTOPLAY_WATCHDOG_MS);
      // Phase 2 watchdog: Phase 1 (load+play 直接呼び直し) でも playing が観測でき
      // なかったケースは、署名 URL 期限切れ / CDN 接続恒久切断など URL 起因の
      // 可能性が高い。`video-active-stuck` を window dispatch して FeedItem 側で
      // force re-resolve (useResolvedVideoSrc.handleError) を起こす。
      // 1 active session につき 1 回だけ。
      //
      // 重要: paused チェックは使わない。video.play() は呼んだ瞬間に paused=false
      // にされる (Promise pending のままでも) ため、play() を 1 度でも呼んだ後の
      // watchdog では `paused === false` がほぼ常に成立し silent no-op になる。
      // 「本当に再生開始したか」は playing イベント観測 (activePlayingObservedRef)
      // で判定する。
      if (needArmPhase2) activeAutoplayStuckTimerRef.current = setTimeout(() => {
        activeAutoplayStuckTimerRef.current = null;
        const liveVideo =
          videoRef.current && videoRef.current.isConnected
            ? videoRef.current
            : watchdogVideo;
        let bail: string | null = null;
        if (armAttemptId !== activeAutoplayAttemptIdRef.current) bail = "stale-attempt";
        else if (!isActiveRef.current) bail = "inactive";
        else if (userPausedRef.current) bail = "user-paused";
        else if (!liveVideo) bail = "no-element";
        else if (isEffectivelyPlaying(liveVideo)) {
          activePlayingObservedRef.current = true;
          bail = "playing-effective";
        }
        else if (activeAutoplayStuckSignaledRef.current) bail = "already-signaled";
        else if (liveVideo.readyState >= 3 && !liveVideo.paused) bail = `rs-ok=${liveVideo.readyState}`;
        // Phase 1 と同様、seek 飛行中は stuck 扱いせず Phase 2 dispatch を抑止。
        // 真の死 element なら deadline 後に in-flight=false となり、次の active
        // session の watchdog で救済される。
        else if (proActressSeekInFlightRef.current) bail = "pro-actress-seek";
        // pro-actress enforce が `deferred reason=promote rs=0` で待機していて、
        // loadedmetadata は到達 (rs>=1) したが currentTime はまだ 0 (= seek が
        // 反映前 / seeked 観測前) のケース。handleLoadedMeta -> enforceLowerBound ->
        // seeked -> tryConsumePlayRetry が直後に走る (= seek-in-flight 経由で
        // 救済される) ので、ここで stuck dispatch (URL force re-resolve) して全体を
        // hard-reset する必要は無い。bail して次の active session に委ねる。
        // 条件: rs>=HAVE_METADATA(1) (= metadata は到達済み) で、
        //       proActressPlayRetryPendingRef が立っており、currentTime が lower 未満。
        else if (
          proActressPlayRetryPendingRef.current &&
          skipEffectiveRef.current &&
          skipLowerBoundRef.current > 0 &&
          liveVideo.readyState >= 1 &&
          liveVideo.currentTime + 0.05 < skipLowerBoundRef.current
        ) bail = "pro-actress-deferred-seek";
        // Phase 1 と同じく「minStart 到達後の再バッファ継続中」は stuck では
        // ない。Phase 2 は dispatch (URL force-resolve + recovery) が走ると
        // 後続の delayed seeked / canplay が stale-element 化するので、ここで
        // 確実に bail して進行中の Range request に委ねる。
        else if (
          skipEffectiveRef.current &&
          skipLowerBoundRef.current > 0 &&
          liveVideo.currentTime + 0.05 >= skipLowerBoundRef.current &&
          liveVideo.networkState === 2 &&
          liveVideo.readyState >= 1 &&
          liveVideo.readyState <= 2 &&
          liveVideo.error === null
        ) bail = "pro-actress-seek-loading";
        if (bail) {
          if (isVideoTimingEnabled()) {
            // eslint-disable-next-line no-console
            console.debug(
              `vt ${slug}: active autoplay watchdog bail phase=2 reason=${bail}`,
            );
          }
          return;
        }
        const target = liveVideo as HTMLVideoElement;
        // stuck signal の dispatch ロジック (cooldown + ログ + window event)。
        // Phase 2 即時発火経路と、後段の loading-grace 経路の両方から呼ばれる。
        const dispatchStuckSignal = (el: HTMLVideoElement, source: string) => {
          const STUCK_COOLDOWN_MS = 5000;
          const now = Date.now();
          const last = lastStuckSignalRef.current;
          if (last.slug === slug && now - last.at < STUCK_COOLDOWN_MS) {
            activeAutoplayStuckSignaledRef.current = true;
            if (isVideoTimingEnabled()) {
              // eslint-disable-next-line no-console
              console.debug(
                `vt ${slug}: active autoplay stuck signal suppressed reason=cooldown delta=${now - last.at}ms source=${source}`,
              );
            }
            return;
          }
          lastStuckSignalRef.current = { slug, at: now };
          activeAutoplayStuckSignaledRef.current = true;
          if (isVideoTimingEnabled()) {
            // eslint-disable-next-line no-console
            console.debug(
              `vt ${slug}: active autoplay stuck signal rs=${el.readyState} networkState=${el.networkState} currentTime=${el.currentTime.toFixed(2)} hasError=${el.error !== null} same-el=${el === watchdogVideo} source=${source}`,
            );
          }
          try {
            window.dispatchEvent(
              new CustomEvent("video-active-stuck", { detail: { slug } }),
            );
          } catch {
            /* ignore */
          }
        };
        // Phase 2 到達時点で rs=0 / networkState=NETWORK_LOADING(2) / no error /
        // currentTime=0 のままなら、ブラウザがまさに Range request 中 (metadata
        // 未到達) のことが多い。ここで stuck signal を発火すると sameUrl
        // force-resolve + recovery が走り、in-flight load を AbortError で kill
        // して逆に latency が悪化する (実測で +6s 程度の delay を確認)。
        // 真の死 (rs=0 で networkState=EMPTY|NO_SOURCE 等) はこの条件を満たさず
        // 即時 dispatch される。loading-grace timer (ACTIVE_AUTOPLAY_LOADING_GRACE_MS)
        // を 1 度だけ武装し、依然として進捗無しなら本当に死んでいると判定。
        const ACTIVE_AUTOPLAY_LOADING_GRACE_MS = 6500;
        // 早期 fail-fast 用の中間チェック: grace のフル待機 (6.5s) を待つと、
        // 「Range request は飛んでいるが何も返ってきていない (= buffered.length===0)」
        // 完全に詰まったケースで救済が遅れる。中間時点で進捗ゼロなら早期に
        // stuck signal を発火して force-resolve recovery を起こす。
        const ACTIVE_AUTOPLAY_LOADING_GRACE_EARLY_MS = 3500;
        if (
          target.readyState === 0 &&
          target.networkState === 2 &&
          target.error === null &&
          !activeAutoplayLoadingGraceArmedRef.current
        ) {
          activeAutoplayLoadingGraceArmedRef.current = true;
          if (isVideoTimingEnabled()) {
            // eslint-disable-next-line no-console
            console.debug(
              `vt ${slug}: active autoplay watchdog bail phase=2 reason=active-loading-no-metadata grace=${ACTIVE_AUTOPLAY_LOADING_GRACE_MS} early=${ACTIVE_AUTOPLAY_LOADING_GRACE_EARLY_MS}`,
            );
          }
          if (activeAutoplayLoadingGraceTimerRef.current != null) {
            clearTimeout(activeAutoplayLoadingGraceTimerRef.current);
          }
          const graceAttemptId = armAttemptId;
          const graceWatchdogVideo = watchdogVideo;
          // フル grace 満了時に走るロジック (関数化)。早期 fail-fast チェックが
          // 「進捗あり」と判定した場合はこれを後段でスケジュールする。
          const runFullGraceExpiry = () => {
            activeAutoplayLoadingGraceTimerRef.current = null;
            const graceLive =
              videoRef.current && videoRef.current.isConnected
                ? videoRef.current
                : graceWatchdogVideo;
            let graceBail: string | null = null;
            if (graceAttemptId !== activeAutoplayAttemptIdRef.current) graceBail = "stale-attempt";
            else if (!isActiveRef.current) graceBail = "inactive";
            else if (userPausedRef.current) graceBail = "user-paused";
            else if (!graceLive) graceBail = "no-element";
            else if (activeAutoplayStuckSignaledRef.current) graceBail = "already-signaled";
            else if (isEffectivelyPlaying(graceLive)) {
              activePlayingObservedRef.current = true;
              graceBail = "playing-effective";
            }
            else if (graceLive.readyState >= 1) graceBail = `metadata-arrived rs=${graceLive.readyState}`;
            else if (proActressSeekInFlightRef.current) graceBail = "pro-actress-seek";
            if (graceBail) {
              if (isVideoTimingEnabled()) {
                // eslint-disable-next-line no-console
                console.debug(
                  `vt ${slug}: active autoplay loading-grace bail reason=${graceBail}`,
                );
              }
              return;
            }
            if (isVideoTimingEnabled()) {
              // eslint-disable-next-line no-console
              console.debug(
                `vt ${slug}: active autoplay loading-grace expired -> stuck rs=${graceLive.readyState} networkState=${graceLive.networkState} currentTime=${graceLive.currentTime.toFixed(2)} hasError=${graceLive.error !== null}`,
              );
            }
            dispatchStuckSignal(graceLive as HTMLVideoElement, "loading-grace");
          };
          // 中間チェック: ACTIVE_AUTOPLAY_LOADING_GRACE_EARLY_MS 経過時点で進捗が
          // 全く無い (buffered.length===0 かつ rs=0 のまま) なら、フル grace を
          // 待たずに stuck signal を発火する。これにより、本当に Range が返って
          // きていない死 element を 3.5s で救済できる。進捗が見える (buffered>0 や
          // rs>=1) ならフル grace 残り時間を待つ。
          activeAutoplayLoadingGraceTimerRef.current = setTimeout(() => {
            activeAutoplayLoadingGraceTimerRef.current = null;
            const earlyLive =
              videoRef.current && videoRef.current.isConnected
                ? videoRef.current
                : graceWatchdogVideo;
            if (
              graceAttemptId !== activeAutoplayAttemptIdRef.current ||
              !isActiveRef.current ||
              userPausedRef.current ||
              !earlyLive ||
              activeAutoplayStuckSignaledRef.current
            ) {
              // 状況変化済み: フル grace は走らせず黙って降りる (再 arm は別経路)。
              return;
            }
            const noProgress =
              earlyLive.readyState === 0 &&
              earlyLive.buffered.length === 0 &&
              earlyLive.currentTime === 0;
            if (noProgress) {
              if (isVideoTimingEnabled()) {
                // eslint-disable-next-line no-console
                console.debug(
                  `vt ${slug}: active autoplay loading-grace early-fail rs=0 buffered=0 -> stuck`,
                );
              }
              dispatchStuckSignal(earlyLive as HTMLVideoElement, "loading-grace-early");
              return;
            }
            // 進捗あり -> 残り時間でフル grace 完了を待つ
            activeAutoplayLoadingGraceTimerRef.current = setTimeout(
              runFullGraceExpiry,
              ACTIVE_AUTOPLAY_LOADING_GRACE_MS - ACTIVE_AUTOPLAY_LOADING_GRACE_EARLY_MS,
            );
          }, ACTIVE_AUTOPLAY_LOADING_GRACE_EARLY_MS);
          return;
        }
        dispatchStuckSignal(target, "phase2");
      }, ACTIVE_AUTOPLAY_STUCK_MS);
      // playVideo (= 既存の muted フォールバック / proActress 開始位置 seek 込み) に
      // そのまま委譲する。playVideo 内で resolve/reject は握り潰されているが、
      // vt 観測用には play() 自体を直接呼んで resolve/reject をログに残す。
      const playPromise = video.play();
      if (playPromise === undefined) {
        // 古い Safari など Promise を返さないブラウザの保険。
        isPlayingRef.current = true;
        startProgressLoop();
        return;
      }
      playPromise.then(
        () => {
          if (videoRef.current !== video) return;
          if (!isActiveRef.current) return;
          if (userPausedRef.current) return;
          isPlayingRef.current = true;
          startProgressLoop();
          if (isVideoTimingEnabled()) {
            // eslint-disable-next-line no-console
            console.debug(
              `vt ${slug}: active autoplay resolved reason=${reason} paused=${video.paused} rs=${video.readyState}`,
            );
          }
          // play() promise が resolve した時点で rs>=3 かつ !paused なら、playing
          // イベントの到来を待たずに「実質再生中」とみなして watchdog を解除する。
          // playing イベントは effect 再走 / boundElement rebind のタイミング次第で
          // 取りこぼされることがあり、その状態で Phase 1 が load() を撃つと
          // 動いていた再生が止まる回帰になる。resolved + rs>=3 は強い成功シグナルなので
          // ここで先回りクリアして良い。
          if (!video.paused && video.readyState >= 3) {
            activePlayingObservedRef.current = true;
            const hadP0 = activeAutoplayLoadKickTimerRef.current != null;
            const hadP1 = activeAutoplayWatchdogRef.current != null;
            const hadP2 = activeAutoplayStuckTimerRef.current != null;
            const hadPG = activeAutoplayLoadingGraceTimerRef.current != null;
            if (hadP0) {
              clearTimeout(activeAutoplayLoadKickTimerRef.current!);
              activeAutoplayLoadKickTimerRef.current = null;
            }
            if (hadP1) {
              clearTimeout(activeAutoplayWatchdogRef.current!);
              activeAutoplayWatchdogRef.current = null;
            }
            if (hadP2) {
              clearTimeout(activeAutoplayStuckTimerRef.current!);
              activeAutoplayStuckTimerRef.current = null;
            }
            if (hadPG) {
              clearTimeout(activeAutoplayLoadingGraceTimerRef.current!);
              activeAutoplayLoadingGraceTimerRef.current = null;
            }
            if ((hadP0 || hadP1 || hadP2 || hadPG) && isVideoTimingEnabled()) {
              // eslint-disable-next-line no-console
              console.debug(
                `vt ${slug}: active autoplay watchdog cleared reason=resolved-rs-ok p0=${hadP0} p1=${hadP1} p2=${hadP2} pg=${hadPG}`,
              );
            }
          }
        },
        (err: unknown) => {
          const e = err as { name?: string; message?: string } | null;
          const name = e?.name ?? "Error";
          const message = e?.message ?? String(err);
          // play() の resolve/reject はマイクロタスクで遅延するため、ここに来た時点で
          // 既にスライドが非 active へ移っているケースがある (スワイプ直後の pause() で
          // AbortError が立つ等)。それを `rejected` として出すと「stale 状態の play
          // 失敗」と「現 active 状態の真の失敗」が同じ vt ラベルになってしまい、
          // 例えば直前 active 49ekdv... の AbortError が新 active 中の vt ログに
          // 混じり原因分析が困難になる。stale 系は別ラベル (`abort reason=stale-active`)
          // で短く出し、muted fallback も走らせない。
          const stale = !isActiveRef.current || videoRef.current !== video;
          if (isVideoTimingEnabled()) {
            if (stale) {
              // eslint-disable-next-line no-console
              console.debug(
                `vt ${slug}: active autoplay abort reason=stale-active trigger=${reason} name=${name}`,
              );
            } else {
              // eslint-disable-next-line no-console
              console.debug(
                `vt ${slug}: active autoplay rejected reason=${reason} name=${name} message=${message} paused=${video.paused} rs=${video.readyState}`,
              );
            }
          }
          // muted fallback。playVideo の中で muted=true → play() を 1 度だけ呼ぶ。
          // ループしないよう既に再生中 / 非 active / user-paused なら skip。
          if (stale) return;
          if (userPausedRef.current) return;
          if (!video.paused) return;
          void playVideo(video, false);
        },
      );
    },
    [playVideo, slug, startProgressLoop, markProActressSeekInFlight, hardResetActiveLoad],
  );

  // force re-resolve 完了後の active 要素救済。
  //
  // 呼び出し元: FeedItem の forceResolveEpoch watcher。useResolvedVideoSrc の
  // handleError() が成功 (= phase=ready) した直後に 1 回だけ呼ばれる。
  //
  // 目的:
  //   `video-active-stuck` から force-resolve が走り新 URL が来ても、
  //   - URL 文字列が同一なら FeedItemVideo の src-sync effect が早期 return して
  //     load()/play() が走らない
  //   - URL が変わっても watchdog の recovered/signaled flag が立っているので、
  //     後続の attemptActiveAutoplay 経路で Phase 1/2 が再 arm されない
  // という二重の no-op で active 要素が rs=0 のまま黒画面で固まる。
  //
  // この関数は session レベルの状態を 1 回だけリセットし、active 要素を強制的に
  // load() + play() の流れに戻す。リトライ上限は useResolvedVideoSrc 側
  // (MAX_FORCE_RETRIES + 指数バックオフ) で既に管理されているので、ここでは
  // 「force-resolve が ready を生むたびに 1 回ずつ」が自然な上限になる。
  const recoverActiveAfterForceResolve = useCallback(
    (urlAfter: string) => {
      if (!isActiveRef.current) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: active recovery abort reason=inactive`,
          );
        }
        return;
      }
      if (userPausedRef.current) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: active recovery abort reason=user-paused`,
          );
        }
        return;
      }
      const video = videoRef.current;
      if (!video) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: active recovery abort reason=no-element -> force-fallback`,
          );
        }
        // host-only (canPromote=true で pool entry が canplay 未到達) のまま
        // force-resolve が走った場合、ここで諦めると videoRef は永久に null のまま
        // となり stuck が解消されない。FeedItem に force-fallback を要求して
        // JSX <video> を強制マウントさせる経路に逃がす。
        try {
          window.dispatchEvent(
            new CustomEvent("video-force-fallback", {
              detail: { slug, reason: "recovery-no-element" },
            }),
          );
        } catch {
          /* ignore */
        }
        return;
      }
      // 既に再生中なら何もしない (force-resolve が走っても実は鳴っていたケース)。
      if (
        !video.paused &&
        video.readyState >= 3 &&
        activePlayingObservedRef.current
      ) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: active recovery abort reason=already-playing rs=${video.readyState}`,
          );
        }
        return;
      }

      // Phase 0/1/2 watchdog の latch を解除して、recover 後の新 session で
      // 必要なら再 arm できるようにする。playing 観測も再度ゼロから観測しなおす
      // (force-resolve 後の play() は別 attempt として扱う)。
      activeAutoplayRecoveredRef.current = false;
      activeAutoplayStuckSignaledRef.current = false;
      activeAutoplayLoadKickedRef.current = false;
      activeAutoplayLoadingGraceArmedRef.current = false;
      activePlayingObservedRef.current = false;
      if (activeAutoplayLoadKickTimerRef.current != null) {
        clearTimeout(activeAutoplayLoadKickTimerRef.current);
        activeAutoplayLoadKickTimerRef.current = null;
      }
      if (activeAutoplayWatchdogRef.current != null) {
        clearTimeout(activeAutoplayWatchdogRef.current);
        activeAutoplayWatchdogRef.current = null;
      }
      if (activeAutoplayStuckTimerRef.current != null) {
        clearTimeout(activeAutoplayStuckTimerRef.current);
        activeAutoplayStuckTimerRef.current = null;
      }
      if (activeAutoplayLoadingGraceTimerRef.current != null) {
        clearTimeout(activeAutoplayLoadingGraceTimerRef.current);
        activeAutoplayLoadingGraceTimerRef.current = null;
      }
      // attemptId を進めて、古い session の延長で発火する setTimeout を bail させる。
      activeAutoplayAttemptIdRef.current += 1;

      // active 要素の src を新 URL に強制同期。
      //
      // 分岐:
      //   (a) URL が変わった (CDN 期限切れ -> 新 host): src を再代入 + load()。
      //       これは新 URL に対する新規ロードなので Range request が clean に始まる。
      //   (b) 同一 URL (sameUrl=true) で element が stuck (rs<HAVE_CURRENT_DATA かつ
      //       networkState が NO_SOURCE(3)/IDLE(1)/EMPTY(0)): 単純な load() では
      //       「pending な Range request」「pending play() promise」「pending seek」
      //       が打ち切られ、AbortError ループを誘発する事例があった (戻りスワイプ後の
      //       promote + Phase1 watchdog + 本 recovery が連鎖した case)。ここでは
      //       完全 detach (removeAttribute("src") + load() で element 状態をリセット)
      //       してから src を再アタッチして load() する。これにより:
      //         - 旧 Range request が dispose される
      //         - pending play() promise が NotSupportedError として確定的に reject
      //           され、後段の wait-for-load+play 経路と競合しない
      //         - pending seek もクリア
      //   (c) sameUrl=true だがすでに rs>=HAVE_CURRENT_DATA: element は読み込みが
      //       進んでいるので detach せずに load() だけ (これは ID か playhead の小
      //       リセットで十分なケース)。
      const currentSrc = video.currentSrc || video.src;
      const sameUrl = currentSrc === urlAfter;
      // sameUrl=true のときは load()/hard-reset を撃たない (in-flight Range と pending
      // play() を維持して AbortError 連鎖を回避)。play() retry は後段の
      // loadedmetadata/canplay/loadeddata listener -> tryFireRecoveryPlay 経路に委ねる。
      const needsHardReset = false;
      const skipLoad = sameUrl;
      if (!sameUrl && urlAfter) {
        try { video.pause(); } catch { /* ignore */ }
        try { video.src = urlAfter; } catch { /* ignore */ }
        try { video.load(); } catch { /* ignore */ }
      }
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slug}: active recovery applying url sameUrl=${sameUrl} skipLoad=${skipLoad} hardReset=${needsHardReset} rs=${video.readyState} networkState=${video.networkState}`,
        );
      }

      // recovery の play() は load() と直列化する。
      //
      // 従来は load() の直後に attemptActiveAutoplay("recovery") を呼んで video.play()
      // を即時発火していたが、Phase1 watchdog の load()+play() と本 recovery の
      // load()+play() が同 element 上で重なると、HTMLMediaElement 側は連続した
      // load() ごとに「直前 play() promise を AbortError で reject」する仕様のため
      // pending な play() が打ち切られ、リトライ → 再度 abort … の loop に入る。
      //
      // 解決策: load() を撃った直後の play() は撃たず、loadedmetadata / canplay /
      // loadeddata / error / abort のいずれかが届くまで wait する。これらは「load()
      // が新しい Range request を始めて少なくとも 1 RTT 完了した」シグナルなので、
      // 以降の play() は前の load() と競合しない。
      //
      // pro-actress minStart は loadedmetadata 後の handleLoadedMeta + enforceLowerBound
      // で必ず開始位置に飛ばされるので、ここでは seek しない (rs=0 で seek すると
      // pending seek が立ち、次の load() で abort されるのを誘発する)。
      const targetEl = video;
      const state: {
        consumed: boolean;
        deadlineTimer: ReturnType<typeof setTimeout> | null;
        onReady: (() => void) | null;
        onAbort: (() => void) | null;
      } = { consumed: false, deadlineTimer: null, onReady: null, onAbort: null };
      const cleanup = () => {
        if (state.onReady) {
          targetEl.removeEventListener("loadedmetadata", state.onReady);
          targetEl.removeEventListener("canplay", state.onReady);
          targetEl.removeEventListener("loadeddata", state.onReady);
        }
        if (state.onAbort) {
          targetEl.removeEventListener("error", state.onAbort);
          targetEl.removeEventListener("abort", state.onAbort);
        }
        if (state.deadlineTimer != null) {
          clearTimeout(state.deadlineTimer);
          state.deadlineTimer = null;
        }
      };
      const tryFireRecoveryPlay = (triggerLabel: string) => {
        if (state.consumed) return;
        state.consumed = true;
        cleanup();
        if (!isActiveRef.current) return;
        if (userPausedRef.current) return;
        if (videoRef.current !== targetEl) {
          // rebind が起きていた場合は現要素を対象に attemptActiveAutoplay へ任せる。
          if (isVideoTimingEnabled()) {
            // eslint-disable-next-line no-console
            console.debug(
              `vt ${slug}: active recovery play deferred reason=rebind trigger=${triggerLabel}`,
            );
          }
          attemptActiveAutoplay("recovery");
          return;
        }
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: active recovery play retry trigger=${triggerLabel} rs=${targetEl.readyState} paused=${targetEl.paused}`,
          );
        }
        attemptActiveAutoplay("recovery");
      };
      state.onReady = () =>
        tryFireRecoveryPlay(
          targetEl.readyState >= 3
            ? "canplay"
            : targetEl.readyState >= 2
              ? "loadeddata"
              : "metadata",
        );
      state.onAbort = () => tryFireRecoveryPlay("abort-or-error");
      targetEl.addEventListener("loadedmetadata", state.onReady, { once: true });
      targetEl.addEventListener("canplay", state.onReady, { once: true });
      targetEl.addEventListener("loadeddata", state.onReady, { once: true });
      targetEl.addEventListener("error", state.onAbort, { once: true });
      targetEl.addEventListener("abort", state.onAbort, { once: true });
      // 既に rs>=1 なら同期で発火 (load() が同期的に成立しているケース、または
      // sameUrl=true で hardReset しなかったケース)。
      if (targetEl.readyState >= 1) {
        queueMicrotask(() => tryFireRecoveryPlay("immediate"));
      }
      // 最終締切: イベントが何も来ない死 element の保険。これ以上待っても無駄なので
      // attemptActiveAutoplay にフォールバック (= watchdog の再武装に委ねる)。
      const RECOVERY_DEADLINE_MS = 2500;
      state.deadlineTimer = setTimeout(() => {
        state.deadlineTimer = null;
        tryFireRecoveryPlay("deadline");
      }, RECOVERY_DEADLINE_MS);
    },
    [attemptActiveAutoplay, slug],
  );

  // 画質切替 (低⇄高) の直前に呼ぶ。現在の再生位置を退避しておき、src 差し替え後の
  // loadedmetadata で同位置へ seek し直して「切替で最初から再生」になるのを防ぐ。
  // 切替先 <video> が rs>=1 で既にメタデータを持っている (= 同 element の src 差し替え)
  // ケースでは loadedmetadata が来ないことがあるため、ここでは退避だけ行い、seek は
  // 呼び出し側 (FeedItem) が src 反映後に applyQualitySwitchResume() で確定させる。
  const noteQualitySwitch = useCallback(() => {
    const video = videoRef.current;
    const t = video ? video.currentTime : 0;
    if (t > 0.5) {
      qualitySwitchResumeRef.current = { slug, time: t };
      lastPlaybackRef.current = { slug, time: t };
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(`vt ${slug}: quality-switch resume noted t=${t.toFixed(2)}`);
      }
    }
  }, [slug]);

  // src 反映後、退避した位置へ実際に seek して再生を継続する。
  //
  // 重要 (sticky resume): 1 回 seek を撃っても、画質切替直後は autoplay 経路の
  // force-load / hardReset / watchdog phase1 の load() / rebuffer load-kick などが
  // 続けて発火し、その都度 currentTime が 0 に巻き戻されることがある。そこで
  // resume ref は「実際に target 付近まで再生位置が到達する」まで保持し、
  // loadedmetadata / loadeddata / canplay / timeupdate / seeked / playing の各
  // イベントから本関数を繰り返し呼んで再 seek する。これにより「途中で何度
  // load() が走っても最終的に切替前の位置から再生が続く」を保証する。
  //
  // 戻り値はデバッグ用ではなく内部分岐用に使わない。冪等で副作用のみ。
  const applyQualitySwitchResume = useCallback(() => {
    const resume = qualitySwitchResumeRef.current;
    if (!resume || resume.slug !== slug) return;
    const video = videoRef.current;
    if (!video) return;
    if (video.readyState < 1) return; // metadata 未到達。後続イベントで再試行する。
    const dur = video.duration;
    let target = resume.time;
    if (skipEffectiveRef.current && skipLowerBoundRef.current > 0 && target < skipLowerBoundRef.current) {
      target = skipLowerBoundRef.current;
    }
    if (!Number.isFinite(dur) || target >= dur - 0.5) {
      // duration 不明 or 切替先の尺が短く target が終端付近。これ以上ねばっても
      // 復元できないので resume を破棄して通常再生に委ねる。
      qualitySwitchResumeRef.current = null;
      return;
    }
    // 既に target 付近まで来ている (= seek が効いて再生が継続している) なら完了。
    if (Math.abs(video.currentTime - target) <= 0.5) {
      lastPlaybackRef.current = { slug, time: video.currentTime };
      qualitySwitchResumeRef.current = null;
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slug}: quality-switch resume settled t=${video.currentTime.toFixed(2)} rs=${video.readyState}`,
        );
      }
      return;
    }
    // target より十分先まで進んでいる (ユーザーが前方シークした等) なら resume は
    // 不要。これ以上巻き戻さない。
    if (video.currentTime > target + 0.5) {
      qualitySwitchResumeRef.current = null;
      return;
    }
    // まだ 0 付近 / target 未到達。seek を撃つ。ref は保持したままにして、
    // 直後に別の load() で 0 に戻されても次のイベントで再適用できるようにする。
    try { video.currentTime = target; } catch { /* ignore */ }
    lastPlaybackRef.current = { slug, time: target };
    if (isVideoTimingEnabled()) {
      // eslint-disable-next-line no-console
      console.debug(
        `vt ${slug}: quality-switch resume applied t=${target.toFixed(2)} rs=${video.readyState}`,
      );
    }
  }, [slug]);

  // pending intent を「現状の videoRef + 状態」で消費する。
  // 同じ slug/videoSrc に対して active かつ要素がある場合に限り、reason=element-bound で
  // attemptActiveAutoplay を呼ぶ。消費後は intent をクリアする (重複起動防止)。
  const tryConsumePendingActiveAutoplay = useCallback(
    (trigger: "element-bound" | "canplay" | "metadata" | "loadeddata") => {
      const intent = pendingActiveAutoplayRef.current;
      if (!intent) return;
      if (intent.slug !== slug) {
        // slug 変化で stale。捨てる。
        pendingActiveAutoplayRef.current = null;
        return;
      }
      if (intent.videoSrc !== videoSrc) {
        // videoSrc 差し替え (force リトライ等) でもこの intent は古い。
        pendingActiveAutoplayRef.current = null;
        return;
      }
      if (!isActiveRef.current) {
        pendingActiveAutoplayRef.current = null;
        return;
      }
      if (userPausedRef.current) {
        pendingActiveAutoplayRef.current = null;
        return;
      }
      const video = videoRef.current;
      if (!video) {
        // まだ要素が無い。intent は保持して次の機会を待つ。
        return;
      }
      // 消費。
      pendingActiveAutoplayRef.current = null;
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slug}: active autoplay start reason=element-bound trigger=${trigger} rs=${video.readyState} paused=${video.paused}`,
        );
      }
      // reason は "element-bound" に統一して、no-element defer のフォローアップが
      // 必ずこの label で観測できるようにする。attemptActiveAutoplay 内のログでは
      // この reason を使う。
      attemptActiveAutoplay("element-bound");
    },
    [attemptActiveAutoplay, slug, videoSrc],
  );

  // active-change / src 解決 / 要素 rebind (promoted swap) / force-fallback remount
  // のいずれかで自動再生を起動。
  useEffect(() => {
    if (!isActive) return;
    if (!videoSrc) return;
    const video = videoRef.current;
    if (!video) {
      // この commit では videoRef がまだ null。boundElement が non-null に
      // 変化したときに deps 再評価で再走するが、commit 中に videoRef.current が
      // null→non-null になる race で再走後も null のまま early return するケースが
      // あるため、明示的な pending intent を立てておき、boundElement 変化後の
      // microtask / canplay 系イベント / 安全網 effect の同期チェックで消費する。
      pendingActiveAutoplayRef.current = { slug, videoSrc };
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slug}: active autoplay defer reason=no-element bound=${boundElement ? "set" : "null"} fbEpoch=${fallbackEpoch}`,
        );
      }
      return;
    }
    isActiveRef.current = true;
    // 新しく active になったスライドは自動再生対象。前作品で残った userPausedRef は破棄する。
    userPausedRef.current = false;
    // 要素が今 bind されたので保留 intent はもう不要。
    pendingActiveAutoplayRef.current = null;
    // promote 由来 (boundElement non-null) と通常マウントを reason で区別する。
    // 同じ commit で promoted swap + active 化が起きるケースは promote 側を優先。
    // force-fallback (key 変更による remount) の場合は専用 reason で観測しやすくする。
    let reason: "promote" | "active-change" | "force-fallback";
    if (fallbackEpoch > 0 && !boundElement) {
      reason = "force-fallback";
    } else if (boundElement) {
      reason = "promote";
    } else {
      reason = "active-change";
    }
    if (reason === "force-fallback" && isVideoTimingEnabled()) {
      // eslint-disable-next-line no-console
      console.debug(
        `vt ${slug}: force-fallback autoplay rearm epoch=${fallbackEpoch} rs=${video.readyState}`,
      );
    }
    attemptActiveAutoplay(reason);
  }, [isActive, videoSrc, boundElement, fallbackEpoch, attemptActiveAutoplay, slug]);

  // boundElement (= promoted 要素) が non-null になった commit では、子の
  // FeedItemVideo useLayoutEffect で videoRef.current が adopted 要素に書き換わる。
  // 親の useEffect (上の active-change effect) は子の useLayoutEffect より後に走る
  // ことが期待されるが、commit 順序や条件分岐で稀に「effect は走ったが ref はまだ
  // null」になるケースが観測されているため、追加の安全網としてここで
  // queueMicrotask を投げて pending intent を遅延消費する。microtask は同 commit の
  // 全 useLayoutEffect 終了後に走るので、ref 設定の取りこぼしを救う。
  useEffect(() => {
    if (!isActive) return;
    if (!videoSrc) return;
    if (!boundElement) return;
    if (!pendingActiveAutoplayRef.current) return;
    queueMicrotask(() => {
      tryConsumePendingActiveAutoplay("element-bound");
    });
  }, [isActive, videoSrc, boundElement, tryConsumePendingActiveAutoplay]);

  // videoSrc が変わったとき (新しい <video> と同じだが src だけ差し替わったときも含む) は
  // hasPlayedRef を false にリセットして、初回ロード (loadstart) ではサムネを出せるようにする。
  useEffect(() => {
    hasPlayedRef.current = false;
  }, [videoSrc]);

  // アンマウント時にスピナー遅延タイマーをクリーンアップ。
  useEffect(() => {
    return () => {
      if (spinnerShowTimerRef.current != null) {
        clearTimeout(spinnerShowTimerRef.current);
        spinnerShowTimerRef.current = null;
      }
      if (activeAutoplayLoadKickTimerRef.current != null) {
        clearTimeout(activeAutoplayLoadKickTimerRef.current);
        activeAutoplayLoadKickTimerRef.current = null;
      }
      if (activeAutoplayWatchdogRef.current != null) {
        clearTimeout(activeAutoplayWatchdogRef.current);
        activeAutoplayWatchdogRef.current = null;
      }
      if (activeAutoplayStuckTimerRef.current != null) {
        clearTimeout(activeAutoplayStuckTimerRef.current);
        activeAutoplayStuckTimerRef.current = null;
      }
      if (activeAutoplayLoadingGraceTimerRef.current != null) {
        clearTimeout(activeAutoplayLoadingGraceTimerRef.current);
        activeAutoplayLoadingGraceTimerRef.current = null;
      }
      // 保留 autoplay intent もアンマウントで破棄。
      pendingActiveAutoplayRef.current = null;
      if (proActressSeekDeadlineRef.current != null) {
        clearTimeout(proActressSeekDeadlineRef.current);
        proActressSeekDeadlineRef.current = null;
      }
      proActressSeekInFlightRef.current = false;
      // ジェスチャ系タイマーもアンマウントで確実に破棄する。これらが残っていると
      // アンマウント後に fireTogglePlay や setState が走り、"unmounted component
      // での更新" 警告や、破棄済み要素への副作用を引き起こす。
      if (longPressTimerRef.current != null) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      if (tapTimerRef.current != null) {
        clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
      }
      if (pcClickTimerRef.current != null) {
        clearTimeout(pcClickTimerRef.current);
        pcClickTimerRef.current = null;
      }
    };
  }, []);

  // isActive=false に切り替わったタイミングで video を停止・リセット。
  //
  // 隣接スライド (isAdjacent) では <video> がマウントされたまま以下の状態になる:
  //   - 初回マウント直後: opacity=0 (初期 style)、loadeddata で setVideoReady(true) が呼ばれて opacity=1 に
  //   - 中央→隣接遷移 (さっきまで中央で再生していた): この effect で停止に戻す
  //
  // 黒画面 + スピナーの一瞬挟まりを防ぐため、ここで setVideoReady(false) / setSpinnerVisible(true) は
  // 呼ばない (隣接スライドで opacity を 0 に戻すと、次に中央に来た瞬間 loadeddata/playing まで
  // 黒画面が見えてしまう)。スピナーは明示的に非表示にし、中央遷移後は waiting イベントで再表示される。
  //
  // 戻りスワイプの高速復帰について:
  //   従来は中央→隣接遷移で video.currentTime = 0 にリセットしていたが、
  //   - playhead 0 への seek は Chrome/Safari 共に「現在地から離れた位置」への seek
  //     と判断され、デコード済みバッファや一部 buffered range を破棄する契機となる
  //     ことがある。戻りスワイプで同じ <video> が再 active 化する瞬間、rs=0/1 まで
  //     落ちて canplay 待ちが発生して再生開始が体感数百 ms 〜 1s 遅れる。
  //   - lastPlaybackRef には timeupdate ごとに直近 playhead が記録されているため、
  //     currentTime を残しておけば「直前まで見ていた位置」から即時 resume できる
  //     (TikTok と同じ挙動)。前進方向のスワイプでは戻ってこない限り unmount される
  //     ため副作用なし。
  //   playbackRate / muted は念のため戻すが、currentTime は触らない。これにより、
  //   戻りスワイプ時の attemptActiveAutoplay は video.play() を呼ぶだけで rs>=3 の
  //   buffer から即座に再生再開する高速復帰経路を取れる。
  useEffect(() => {
    if (isActive) return;
    const video = videoRef.current;
    isActiveRef.current = false;
    // 隣接スライドに戻ったので、まだ未消化の play retry 予約と userPaused 状態は破棄する
    // (次に中央に戻ったときは userPausedRef=false 起点で再評価される)。
    proActressPlayRetryPendingRef.current = false;
    if (proActressPlayFallbackTimerRef.current != null) {
      clearTimeout(proActressPlayFallbackTimerRef.current);
      proActressPlayFallbackTimerRef.current = null;
    }
    // 戻りスワイプで再 active 化するときに watchdog を再武装できるよう、ここで
    // タイマーをクリアし recovered/signaled flag も false に戻す。
    if (activeAutoplayLoadKickTimerRef.current != null) {
      clearTimeout(activeAutoplayLoadKickTimerRef.current);
      activeAutoplayLoadKickTimerRef.current = null;
    }
    if (activeAutoplayWatchdogRef.current != null) {
      clearTimeout(activeAutoplayWatchdogRef.current);
      activeAutoplayWatchdogRef.current = null;
    }
    if (activeAutoplayStuckTimerRef.current != null) {
      clearTimeout(activeAutoplayStuckTimerRef.current);
      activeAutoplayStuckTimerRef.current = null;
    }
    if (activeAutoplayLoadingGraceTimerRef.current != null) {
      clearTimeout(activeAutoplayLoadingGraceTimerRef.current);
      activeAutoplayLoadingGraceTimerRef.current = null;
    }
    activeAutoplayRecoveredRef.current = false;
    activeAutoplayStuckSignaledRef.current = false;
    activeAutoplayLoadKickedRef.current = false;
    activeAutoplayLoadingGraceArmedRef.current = false;
    activePlayingObservedRef.current = false;
    // attemptId を進めて、既にクリアした timer が万一 setTimeout キューに残って
    // いた場合でも fire 時に stale-attempt として bail させる。
    activeAutoplayAttemptIdRef.current += 1;
    // 非 active になったので pro-actress seek 飛行も終了扱い。
    clearProActressSeekInFlight();
    // active 化時の保留 autoplay intent も非アクティブで破棄する。
    pendingActiveAutoplayRef.current = null;
    userPausedRef.current = false;
    stopProgressLoop();
    if (video) {
      video.pause();
      video.playbackRate = 1;
      video.muted = globalIsMuted;
    }
    isPlayingRef.current = false;
    // shimmer は見せず、次回 loadstart まで非表示を維持。プリフェッチ済スライドで
    // スワイプした瞬間にサムネが一瞬見えるチラつきを避けるため。
    setShimmerVisible(false);
    // スピナーも隣接スライドでは非表示にしておく。中央に来た瞬間バッファ不足 (waiting)
    // が起きたら下の useEffect で setSpinnerVisible(true) される。
    setSpinnerVisible(false);
    setFastBadge(false);
    window.dispatchEvent(new CustomEvent("video-progress", { detail: { progress: 0 } }));
  }, [isActive, setShimmerVisible, setSpinnerVisible, setFastBadge, stopProgressLoop, clearProActressSeekInFlight]);

  // props.isProActress を ref に同期。playVideo (useCallback) から最新値を参照できるようにする。
  // この同期は他の effect (特に autoplay 系の useEffect) より先に走らせたいので、
  // useLayoutEffect を使い、React のコミット直後 (= 子の useEffect が走る前) に
  // 確実に書き込む。以前は useEffect だったためコメントと実装が乖離しており、
  // 初回 active mount で autoplay が古い ref 値 (false) を読む余地があった。
  useLayoutEffect(() => {
    isProActressRef.current = isProActress;
  }, [isProActress]);

  // プロ女優スキップの確定処理。
  //
  // この effect は isActive に関わらず常に走る。隣接スライド (isAdjacent=true) で <video>
  // がマウントされているときにも loadedmetadata で currentTime=5 にシークしておいて、
  // スワイプで中央に来た瞬間即 開始位置 (duration-60) のフレームが見えてから再生開始させるため。
  // (isActive=false で使うのは handleLoadedMeta / handleSeeking まで、ended/timeUpdate は isActive のみ無意味。
  //  ただしイベントリスナを貼るコストは軽いので、全て常にバインドして OK)
  // duration < MIN なら無効化 (短すぎる動画でホボ即終了するのを避ける)。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // この <video> 用の初期値リセット。
    // 末尾スキップ (開始位置 = duration-60) は duration 依存なので、loadedmetadata
    // 確定前は下限を計算できない。よって pending 状態として skipEffectiveRef だけ
    // isProActress を反映し、下限 (skipLowerBoundRef) は 0 のままにしておく
    // (下限 0 の間は enforce / progress-bar は通常動画と同じ挙動)。
    // duration 確定後に evaluate() が duration-60 を計算して下限を確定させる。
    skipEffectiveRef.current = isProActress;
    skipLowerBoundRef.current = 0;

    const evaluate = () => {
      if (!isProActress) {
        skipEffectiveRef.current = false;
        skipLowerBoundRef.current = 0;
        return;
      }
      const dur = video.duration;
      if (!Number.isFinite(dur) || dur <= 0) {
        // メタデータ未確定: 開始位置を計算できないので pending のまま
        // (skipEffectiveRef は true を維持、下限は 0)。後続の loadedmetadata で再評価。
        skipEffectiveRef.current = isProActress;
        skipLowerBoundRef.current = 0;
        return;
      }
      const lower = tailStartForDuration(dur, TAIL_KEEP_SEC);
      if (lower <= 0) {
        // duration <= 60 秒: 残す尺の方が長い = 丸ごと再生 (スキップ無効)。
        skipEffectiveRef.current = false;
        skipLowerBoundRef.current = 0;
        return;
      }
      skipEffectiveRef.current = true;
      skipLowerBoundRef.current = lower;
    };

    const enforceLowerBound = () => {
      if (!skipEffectiveRef.current) return;
      const lower = skipLowerBoundRef.current;
      if (lower <= 0) return;
      // タイマー精度の都合で 4.9 のような値も来るので、わずかにマージンを取って判定する
      if (video.currentTime + 0.05 < lower) {
        // 隣接スライド (isActive=false) かつ paused かつ readyState<=1 のケースは
        // 「adjacent プレビュー用に 開始位置へ seek」「アンマウント / 再初期化途中」など
        // 仕様どおりの seek でログが多くなり過ぎるためログだけ抑制する。
        // 実際の seek (lower-bound enforce) は active/inactive 問わず必要なのでそのまま実行する。
        // 一方、active 中の enforce はリトライ取りこぼし等の重要な signal なので必ずログ。
        const isQuietInactive =
          !isActiveRef.current && video.paused && video.readyState <= 1;
        if (isVideoTimingEnabled() && !isQuietInactive) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: pro-actress enforce currentTime=${video.currentTime.toFixed(2)} -> ${lower} paused=${video.paused} rs=${video.readyState} active=${isActiveRef.current}`,
          );
        }
        // active 経路で seek を撃つ場合は、Phase 0/1/2 watchdog が「rs=1 currentTime=0」を
        // stuck と誤判定しないよう seek-in-flight flag を立てる。seeked で
        // clearProActressSeekInFlight() され、deadline (PRO_ACTRESS_SEEK_DEADLINE_MS) で
        // 確実に降りる。inactive 経路 (preview seek) では立てない。
        if (isActiveRef.current) {
          markProActressSeekInFlight();
        }
        try { video.currentTime = lower; } catch { /* ignore */ }
        // active かつ autoplay 対象 (= ユーザーが明示的に止めていない) で、enforce 直後に
        // 動画が paused のままなら、seeked / canplay 後に一度だけ play() を再試行する。
        // ブラウザによっては play() を await した後の currentTime 設定で再生開始がキャンセル
        // されてしまい、結果として「開始位置に飛んだが paused のまま」になるケースがあるため。
        // 二重トリガー防止のため pending フラグで idempotent にしている。
        if (
          isActiveRef.current &&
          !userPausedRef.current &&
          video.paused
        ) {
          proActressPlayRetryPendingRef.current = true;
        }
      }
    };

    const handleLoadedMeta = () => {
      evaluate();
      // リトライ / 画質切替後のレジューム: 同 slug で直近の再生位置が記録されていれば、
      // その位置に currentTime をセットして「最初からではなく途中から」再生する。
      // プロ女優作品は下限 (開始位置) を超えている限りその位置を採用；超えていなければ enforceLowerBound で開始位置に修正される。
      // 画質切替 (qualitySwitchResumeRef) は sticky なので applyQualitySwitchResume に
      // 委譲し、target 付近に到達するまで後続イベントで再 seek し続ける。
      const dur = video.duration;
      // 画質切替の resume は sticky な applyQualitySwitchResume に委譲する。
      // (切替直後は force-load / hardReset / watchdog の load() で currentTime が
      //  0 に戻されることがあるため、ここで一度 seek して ref を消すのではなく、
      //  各種イベントから繰り返し再 seek して最終的に切替前の位置へ復帰させる。)
      if (
        qualitySwitchResumeRef.current &&
        qualitySwitchResumeRef.current.slug === slug
      ) {
        applyQualitySwitchResume();
      } else if (
        // force-retry 後の resume: 同 slug で直近位置が記録されていれば 1 度だけ復元。
        lastPlaybackRef.current.slug === slug &&
        lastPlaybackRef.current.time > 0.5 &&
        Number.isFinite(dur) &&
        lastPlaybackRef.current.time < dur - 0.5
      ) {
        try { video.currentTime = lastPlaybackRef.current.time; } catch { /* ignore */ }
        lastPlaybackRef.current = { slug, time: lastPlaybackRef.current.time };
      }
      // メタデータ確定直後、初回再生はまだ 0 から始まっている可能性が高いので飛ばす。
      // これにより、isActive=false の隣接スライドでもプロ女優作品は 開始位置 (duration-60) に
      // シークされ、そのフレームがプレビューとして表示される。
      //
      // 加えて、attemptActiveAutoplay が rs=0 で `pro-actress enforce deferred` した
      // ケース (= proActressPlayRetryPendingRef は立っているが currentTime はまだ 0)
      // を metadata 到達と同時に巻き取る。観測ログ:
      //   "pro-actress deferred metadata seek currentTime=0.00 -> 開始位置"
      // これが無いと、Phase 2 watchdog (3500ms) まで currentTime=0 のまま放置され
      // recovery 経路で再 hard-reset+loadedmetadata 待ち (+4 秒) が走る。
      const shouldConsumeDeferred =
        isActiveRef.current &&
        !userPausedRef.current &&
        proActressPlayRetryPendingRef.current &&
        skipEffectiveRef.current &&
        skipLowerBoundRef.current > 0 &&
        video.currentTime + 0.05 < skipLowerBoundRef.current;
      if (shouldConsumeDeferred && isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slug}: pro-actress deferred metadata seek currentTime=${video.currentTime.toFixed(2)} -> ${skipLowerBoundRef.current} rs=${video.readyState} paused=${video.paused}`,
        );
      }
      enforceLowerBound();
    };
    const handleTimeUpdate = () => {
      // 画質切替の位置復元が未完了の間は最優先で再 seek する。復元中は currentTime
      // (切替直後は ≈0) を lastPlaybackRef に書かない。書いてしまうと「0 巻き戻り」が
      // 確定値として記録され、以降の復元が 0 を採用してしまう。
      if (
        qualitySwitchResumeRef.current &&
        qualitySwitchResumeRef.current.slug === slug
      ) {
        applyQualitySwitchResume();
      } else if (isActiveRef.current) {
        // 同 slug 作品の再生位置を記録 (リトライ後に復帰させるため)。
        // 記録は isActive スライドのみ。隣接スライドは paused なので timeupdate はそもそも発火しないが念のため。
        lastPlaybackRef.current = { slug, time: video.currentTime };
      }
      enforceLowerBound();
    };
    const handleSeeking = () => enforceLowerBound();
    const tryConsumePlayRetry = (eventName: "seeked" | "canplay") => {
      if (!proActressPlayRetryPendingRef.current) return;
      // 現在の active 要素と slug にバインド。effect closure 内では video/slug は固定だが、
      // クリーンアップ前に新しい slug の <video> が active になっているケースに備えて
      // ref と突き合わせて stale を弾く。
      //
      // ただし「captured video はもう videoRef ではないが、現 active 要素が同じ
      // hook インスタンスの videoRef.current として存在し、active かつ paused」
      // のケースは、handoff promote 等で <video> が rebind されただけで slug 自体は
      // 変わっていない。この場合は単に「rebind 後の現要素」に対してリトライすべき。
      // useFeedPlayback は slug 1 件につき 1 度マウントされる (FeedItem の key に slug が
      // 紐付くため) 仕様のため、effect closure の `slug` と現状の slug は同一であり、
      // videoRef.current が non-null である限り「同 slug の現 active 要素」として
      // 扱える。
      let target: HTMLVideoElement | null = video;
      if (videoRef.current !== video) {
        const current = videoRef.current;
        if (
          current &&
          isActiveRef.current &&
          !userPausedRef.current &&
          current.paused
        ) {
          if (isVideoTimingEnabled()) {
            // eslint-disable-next-line no-console
            console.debug(
              `vt ${slug}: pro-actress play retry rebind stale-element -> current-element on=${eventName} rs=${current.readyState}`,
            );
          }
          target = current;
        } else {
          if (isVideoTimingEnabled()) {
            // eslint-disable-next-line no-console
            console.debug(
              `vt ${slug}: pro-actress play retry abort reason=stale-element on=${eventName}`,
            );
          }
          proActressPlayRetryPendingRef.current = false;
          return;
        }
      }
      if (!isActiveRef.current) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: pro-actress play retry abort reason=inactive on=${eventName}`,
          );
        }
        proActressPlayRetryPendingRef.current = false;
        return;
      }
      if (userPausedRef.current) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: pro-actress play retry abort reason=user-paused on=${eventName}`,
          );
        }
        proActressPlayRetryPendingRef.current = false;
        return;
      }
      if (!target.paused) {
        // すでに再生中。リトライ不要。
        proActressPlayRetryPendingRef.current = false;
        return;
      }
      // pending を先に消費しておく。playVideo 側で seek が再度発火しても
      // ループしないように idempotent にする。
      proActressPlayRetryPendingRef.current = false;

      const playTarget = target;
      const pausedBefore = playTarget.paused;
      const rsBefore = playTarget.readyState;
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slug}: pro-actress play retry start reason=${eventName} paused=${pausedBefore} rs=${rsBefore}`,
        );
      }

      // 直接 playTarget.play() を呼び、resolve/reject を必ずログに残す。
      // playVideo を経由しないのは:
      //   - 既に lower bound seek 済みなのでもう一度 seek する必要がない
      //   - play() の resolve/reject を観測したいので catch を握り潰さない
      // 失敗時のみ muted fallback として playVideo にエスカレートする。
      playTarget.muted = globalIsMuted;
      const playPromise = playTarget.play();
      if (playPromise === undefined) {
        // 古い Safari など Promise を返さないブラウザの保険。
        // 状態だけ更新して fallback timer に委ねる。
        isPlayingRef.current = true;
        startProgressLoop();
      } else {
        playPromise.then(
          () => {
            if (videoRef.current !== playTarget) return;
            if (!isActiveRef.current) return;
            if (userPausedRef.current) return;
            isPlayingRef.current = true;
            startProgressLoop();
            if (isVideoTimingEnabled()) {
              // eslint-disable-next-line no-console
              console.debug(
                `vt ${slug}: pro-actress play retry resolved paused=${playTarget.paused} rs=${playTarget.readyState}`,
              );
            }
          },
          (err: unknown) => {
            const e = err as { name?: string; message?: string } | null;
            const name = e?.name ?? "Error";
            const message = e?.message ?? String(err);
            if (isVideoTimingEnabled()) {
              // eslint-disable-next-line no-console
              console.debug(
                `vt ${slug}: pro-actress play retry rejected name=${name} message=${message} paused=${playTarget.paused} rs=${playTarget.readyState}`,
              );
            }
            // NotAllowedError は autoplay policy。muted fallback に 1 回だけ落として終わる。
            // それ以外も握らず muted fallback に進む (どのみち失敗するなら 1 回 muted を試して諦める)。
            if (videoRef.current !== playTarget) return;
            if (!isActiveRef.current) return;
            if (userPausedRef.current) return;
            if (!playTarget.paused) return;
            void playVideo(playTarget, false);
          },
        );
      }

      // play() が resolve しても playing イベントが来ないケース (一部ブラウザで
      // currentTime 直前変更後に発生) の最終保険。bounded で 1 回だけ direct play() を
      // 呼び直す。ループ防止のため timer は使用後に必ず null。
      if (proActressPlayFallbackTimerRef.current != null) {
        clearTimeout(proActressPlayFallbackTimerRef.current);
      }
      const PLAY_RETRY_FALLBACK_MS = 800;
      proActressPlayFallbackTimerRef.current = setTimeout(() => {
        proActressPlayFallbackTimerRef.current = null;
        if (videoRef.current !== playTarget) return;
        if (!isActiveRef.current) return;
        if (userPausedRef.current) return;
        if (!playTarget.paused) return; // 既に再生中なら何もしない
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: pro-actress play retry fallback direct play paused=${playTarget.paused} rs=${playTarget.readyState}`,
          );
        }
        const p = playTarget.play();
        if (p && typeof p.then === "function") {
          p.then(
            () => {
              if (isVideoTimingEnabled()) {
                // eslint-disable-next-line no-console
                console.debug(
                  `vt ${slug}: pro-actress play retry fallback resolved paused=${playTarget.paused} rs=${playTarget.readyState}`,
                );
              }
            },
            (err: unknown) => {
              const e = err as { name?: string; message?: string } | null;
              if (isVideoTimingEnabled()) {
                // eslint-disable-next-line no-console
                console.debug(
                  `vt ${slug}: pro-actress play retry fallback rejected name=${e?.name ?? "Error"} message=${e?.message ?? String(err)}`,
                );
              }
              // ここで止める。これ以上は再試行しない (autoplay policy / 端末側の制約)。
            },
          );
        }
      }, PLAY_RETRY_FALLBACK_MS);
    };
    const handleSeeked = () => {
      // pro-actress 0->5 seek が完了したので in-flight flag を落とす。
      // これで Phase 1 / Phase 2 watchdog は通常経路に戻る。
      clearProActressSeekInFlight();
      // 画質切替の位置復元 (sticky)。直前の seek が 0 への巻き戻しだった場合でも
      // ここで target へ再 seek し、target 付近に到達していれば ref を解放する。
      applyQualitySwitchResume();
      enforceLowerBound();
      tryConsumePlayRetry("seeked");
    };
    // duration が loadedmetadata 時点では Infinity / NaN で来て、その後
    // durationchange で確定値が届くブラウザ (iOS/Safari や一部の MP4) 向けの再評価。
    // durationchange を listen していないと、pending (下限 0) のまま確定値を取りこぼし、
    // 末尾スキップが一切効かず最初から再生されてしまう (= 断続的にスキップが効かない主因)。
    const handleDurationChange = () => {
      evaluate();
      enforceLowerBound();
    };
    const handleCanPlay = () => {
      // 画質切替の位置復元 (sticky)。canplay 時点で rs>=3 なので確実に seek できる。
      applyQualitySwitchResume();
      // canplay 時点では duration は確定 (rs>=3) しているので、loadedmetadata で
      // 下限を確定できなかった (Infinity 等) ケースをここで確実に巻き取る。初回 seek が
      // まだ効いていなければ再適用する (二重 seek は enforceLowerBound の下限判定で防止)。
      evaluate();
      enforceLowerBound();
      tryConsumePlayRetry("canplay");
    };
    const handleLoadedDataResume = () => {
      // loadeddata でも復元を試す (canplay より前に来るブラウザ向け)。
      applyQualitySwitchResume();
    };
    // playing イベント時の safety net: rs=0 から rs=4 まで一気に駆け上がって play()
    // が resolve したケースで、loadedmetadata/seeking/seeked の発火順序によっては
    // enforceLowerBound() が一度も走らないことがある (戻りスワイプで pool の古い
    // promoted element を adopt したケースで観測)。
    // currentTime < minStart のまま再生が始まったらここで強制クランプする。
    const handlePlayingEnforce = () => {
      // 画質切替の位置復元 (sticky)。playing 到達時点でまだ 0 付近なら target へ
      // 飛ばす。これにより「load() で 0 に戻ったまま再生が始まってしまう」最後の
      // 取りこぼしも巻き取る。
      if (
        isActiveRef.current &&
        qualitySwitchResumeRef.current &&
        qualitySwitchResumeRef.current.slug === slug
      ) {
        applyQualitySwitchResume();
      }
      if (!isActiveRef.current) return;
      if (!skipEffectiveRef.current) return;
      const lower = skipLowerBoundRef.current;
      if (lower <= 0) return;
      if (video.currentTime + 0.05 >= lower) return;
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slug}: pro-actress enforce on=playing currentTime=${video.currentTime.toFixed(2)} -> ${lower} rs=${video.readyState}`,
        );
      }
      enforceLowerBound();
    };
    const handleEnded = () => {
      // 既存ループ仕様 (HTMLVideoElement の loop 属性は未使用、再生終端で何が起きるかは
      // ブラウザ依存) に合わせ、明示的に開始位置 (duration-60) に戻して再生再開する。
      // isActive=false (隣接スライド) ではそもそも paused なので ended は退火しないが、念のためガード。
      if (!isActiveRef.current) return;
      if (!skipEffectiveRef.current) return;
      const lower = skipLowerBoundRef.current;
      try { video.currentTime = lower > 0 ? lower : 0; } catch { /* ignore */ }
      // loop 未設定でも再開させる。ユーザージェスチャーを失っていることが多いので muted フォールバックで OK。
      void playVideo(video, false);
    };

    // 初期評価 (もう metadata が読めていれば即評価)
    if (video.readyState >= 1) {
      evaluate();
      enforceLowerBound();
    }

    video.addEventListener("loadedmetadata", handleLoadedMeta);
    video.addEventListener("durationchange", handleDurationChange);
    video.addEventListener("loadeddata", handleLoadedDataResume);
    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("seeking", handleSeeking);
    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("canplay", handleCanPlay);
    video.addEventListener("playing", handlePlayingEnforce);
    video.addEventListener("ended", handleEnded);
    // 初期評価で「もう再生が始まっている」(= adopt 時点で promoted が paused=false)
    // ケースを救う safety net。listener attach 後に playing が来ない可能性があるため。
    if (!video.paused && skipEffectiveRef.current && skipLowerBoundRef.current > 0) {
      handlePlayingEnforce();
    }
    return () => {
      video.removeEventListener("loadedmetadata", handleLoadedMeta);
      video.removeEventListener("durationchange", handleDurationChange);
      video.removeEventListener("loadeddata", handleLoadedDataResume);
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("seeking", handleSeeking);
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("canplay", handleCanPlay);
      video.removeEventListener("playing", handlePlayingEnforce);
      video.removeEventListener("ended", handleEnded);
      // 次の <video> インスタンスに pending 状態が漏れないようリセット。
      proActressPlayRetryPendingRef.current = false;
      if (proActressPlayFallbackTimerRef.current != null) {
        clearTimeout(proActressPlayFallbackTimerRef.current);
        proActressPlayFallbackTimerRef.current = null;
      }
    };
    // boundElement を deps に含めることが必須。promote swap / force-fallback /
    // hardReset で videoRef.current が差し替わったとき、deps に含めないと effect が
    // 再走せず、loadedmetadata/seeking/seeked/canplay/timeupdate/ended listener が
    // 旧 (detach 済み) 要素にしか紐付かない。結果として pro-actress enforce 経路全体が
    // 新要素では走らず、5s skip が漏れる。
    // 戻りスワイプで FeedItem が remount される場合は元々 effect が走り直すが、同じ
    // hook インスタンスのまま promoted element が rebind されるケースがあり (P2/P5 系)、
    // そのケースを救うため boundElement を依存に含める。
    // fallbackEpoch も同様に依存。force-fallback で <video> が unmount→remount された
    // 場合に新要素へ listener を確実に張り直す。
  }, [slug, videoSrc, isProActress, boundElement, fallbackEpoch, playVideo, startProgressLoop, clearProActressSeekInFlight, markProActressSeekInFlight, applyQualitySwitchResume]);

  // 自動再生のセーフティネット: active な要素が canplay / loadeddata / loadedmetadata
  // に到達した時点でまだ paused かつ user-paused でないなら、attemptActiveAutoplay を
  // 再起動する。これにより:
  //   - 「active-change effect で play() を呼んだが readyState 不足で reject
  //     された」ようなケースで、後発の canplay で確実に再試行できる。
  //   - 「proActress 経路は走らない (non-proActress 作品)」のに promoted swap
  //     直後に readyState が一時的に下がるエッジケースでも canplay で復帰できる。
  //   - 直接 video.play() を呼ぶので autoplay policy 拒否は active autoplay rejected
  //     としてログに出る (silent fail を防ぐ)。
  // proActress の play-retry とは reason が独立しており、両者が同 commit に走っても
  // playPromise の早期 abort ガード (paused / userPaused / stale-element) で安全に
  // idempotent。
  useEffect(() => {
    if (!isActive) return;
    if (!videoSrc) return;
    const video = videoRef.current;
    if (!video) return;
    const handle = (
      reason: "canplay" | "metadata",
      pendingTrigger: "canplay" | "metadata" | "loadeddata",
    ) => () => {
      if (!isActiveRef.current) return;
      if (userPausedRef.current) return;
      if (!video.paused) return;
      // 先に保留 intent を消費する。これは attemptActiveAutoplay と同じ video 要素 +
      // active/userPaused 条件を見るので順序依存はないが、reason=element-bound ラベルを
      // 確実に残すために先に呼ぶ。intent が無ければ何も起きないので idempotent。
      tryConsumePendingActiveAutoplay(pendingTrigger);
      attemptActiveAutoplay(reason);
    };
    const onCanPlay = handle("canplay", "canplay");
    const onLoadedData = handle("canplay", "loadeddata");
    const onLoadedMeta = handle("metadata", "metadata");
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("loadeddata", onLoadedData);
    video.addEventListener("loadedmetadata", onLoadedMeta);
    // 再バインド直後 (= promoted swap) で既に readyState >= 2 / 3 ならイベントが
    // 来ない可能性が高いので同期チェックして trigger。microtask で送ることで
    // 親 layout effect の videoRef 書き込みが確実に終わってから走る。
    if (video.paused && !userPausedRef.current) {
      const rs = video.readyState;
      if (rs >= 3) {
        queueMicrotask(() => {
          if (!isActiveRef.current) return;
          if (userPausedRef.current) return;
          if (!video.paused) return;
          if (videoRef.current !== video) return;
          tryConsumePendingActiveAutoplay("canplay");
          attemptActiveAutoplay("canplay");
        });
      } else if (rs >= 1) {
        queueMicrotask(() => {
          if (!isActiveRef.current) return;
          if (userPausedRef.current) return;
          if (!video.paused) return;
          if (videoRef.current !== video) return;
          tryConsumePendingActiveAutoplay("metadata");
          attemptActiveAutoplay("metadata");
        });
      }
    }
    return () => {
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("loadedmetadata", onLoadedMeta);
    };
  }, [isActive, videoSrc, boundElement, fallbackEpoch, attemptActiveAutoplay, tryConsumePendingActiveAutoplay]);

  // 再生中の読み込み停滞 (waiting/stalled) と、再生再開 (playing/canplaythrough) を検知して
  // スピナーの表示・非表示を切り替える。isActive 中のときだけビデオ要素が
  // 存在するため、それに依存したイベントリスナをその単位で貼り替える。
  // 再バインド時点で既に再生中ならスピナーを即消ししておく。
  useEffect(() => {
    if (!isActive) return;
    const video = videoRef.current;
    if (!video) return;

    const slugTag = isVideoTimingEnabled() ? slug : "";

    const handleWaiting = () => {
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(`vt ${slugTag}: spinner waiting (active el ts=${video.currentTime.toFixed(2)})`);
      }
      // シーク直後などにも発火するが、バッファが足りればすぐ playing で消えるので問題なし
      setSpinnerVisible(true);
    };
    const handlePlaying = () => {
      hasPlayedRef.current = true;
      // playing 観測フラグ。watchdog はこれを真の "再生開始した" として扱う。
      activePlayingObservedRef.current = true;
      // 再生に乗ったタイミングで pro-actress seek in-flight flag を念のため落とす。
      // 通常は seeked で落ちるが、recovery 経路 (target.currentTime=5) などで
      // seeked が観測されないケースもあるため、playing でも保険的に解除する。
      if (proActressSeekInFlightRef.current) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slugTag}: pro-actress seek in-flight cleared reason=playing`,
          );
        }
        clearProActressSeekInFlight();
      }
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(`vt ${slugTag}: spinner clear (playing on active el)`);
      }
      // 万一、起動タイミングで shimmer が見えていたら明示的に消しておく。
      const shimmer = shimmerRef.current;
      if (shimmer) shimmer.style.display = "none";
      setSpinnerVisible(false);
      // 再生が回り始めたら watchdog を解除する (この session では recover 不要)。
      const hadP0 = activeAutoplayLoadKickTimerRef.current != null;
      const hadP1 = activeAutoplayWatchdogRef.current != null;
      const hadP2 = activeAutoplayStuckTimerRef.current != null;
      const hadPG = activeAutoplayLoadingGraceTimerRef.current != null;
      if (hadP0) {
        clearTimeout(activeAutoplayLoadKickTimerRef.current!);
        activeAutoplayLoadKickTimerRef.current = null;
      }
      if (hadP1) {
        clearTimeout(activeAutoplayWatchdogRef.current!);
        activeAutoplayWatchdogRef.current = null;
      }
      if (hadP2) {
        clearTimeout(activeAutoplayStuckTimerRef.current!);
        activeAutoplayStuckTimerRef.current = null;
      }
      if (hadPG) {
        clearTimeout(activeAutoplayLoadingGraceTimerRef.current!);
        activeAutoplayLoadingGraceTimerRef.current = null;
      }
      if ((hadP0 || hadP1 || hadP2 || hadPG) && isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slugTag}: active autoplay watchdog cleared reason=playing p0=${hadP0} p1=${hadP1} p2=${hadP2} pg=${hadPG}`,
        );
      }
    };
    const handleCanPlayThrough = () => {
      setSpinnerVisible(false);
    };
    const handleStalled = () => {
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(`vt ${slugTag}: spinner stalled (active el)`);
      }
      // ネットワーク遅延でデータが来ないときもスピナーを出す
      setSpinnerVisible(true);
    };

    video.addEventListener("waiting", handleWaiting);
    video.addEventListener("playing", handlePlaying);
    video.addEventListener("canplaythrough", handleCanPlayThrough);
    video.addEventListener("stalled", handleStalled);

    // 再バインド時の同期チェック。
    // paused=false かつ readyState >= HAVE_CURRENT_DATA (=2) なら即スピナーを消す。
    if (!video.paused && video.readyState >= 2) {
      const shimmer = shimmerRef.current;
      if (shimmer) shimmer.style.display = "none";
      setSpinnerVisible(false);
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${slugTag}: spinner clear on rebind (paused=${video.paused} rs=${video.readyState})`,
        );
      }
    }

    return () => {
      video.removeEventListener("waiting", handleWaiting);
      video.removeEventListener("playing", handlePlaying);
      video.removeEventListener("canplaythrough", handleCanPlayThrough);
      video.removeEventListener("stalled", handleStalled);
    };
    // videoSrc / boundElement / fallbackEpoch は videoRef.current が指す実要素を
    // 差し替える (promote / remount / fallback) トリガー。これらを deps に含めない
    // と、要素が入れ替わったときに旧要素へリスナが残り、新要素の playing による
    // spinner clear や activePlayingObservedRef 更新を取り逃がす。autoplay 側の
    // effect (同じ 4 つを deps に持つ) と貼り替えタイミングを一致させる。
  }, [
    isActive,
    videoSrc,
    boundElement,
    fallbackEpoch,
    setSpinnerVisible,
    slug,
    clearProActressSeekInFlight,
  ]);

  // フォールバック: 念のため IntersectionObserver でも監視する。
  // (端末向きを変えたときや SSR ハイドレート直後など、isActive prop の同期前に発火するケースに備える)
  // videoSrc を deps に含めることで、resolver で URL が遅延取得され <video> が今マウントされた
  // ときにも observer を貼り直し、このフォールバック経路でも自動再生を起こせるようにしておく。
  //
  // 重要: isActive=false の隣接スライド (<video> を preload のためにマウントしているケース) では
  // observer で勝手に isActive 扱いにして再生してはいけない。isActive prop を source of truth とし、
  // observer は 「親がすでに isActive=true と見なしているが paused のとき」 に限って再生をトリガーする。
  useEffect(() => {
    if (!isActive) return;
    const video = videoRef.current;
    if (!video) return;
    const playObserver = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      if (!isActiveRef.current) return;
      if (userPausedRef.current) return;
      if (video.paused) {
        // 既に active だが paused のとき (モーダル戻りなど) は再生再開
        attemptActiveAutoplay("observer");
      }
    }, { threshold: PLAY_THRESHOLD });
    playObserver.observe(video);
    return () => {
      playObserver.disconnect();
    };
  }, [attemptActiveAutoplay, isActive, videoSrc, boundElement, fallbackEpoch]);

  // 長押しメニュー・右クリックメニューをフィードアイテム全体で拒否する。
  // 動画コンテナだけだと、サムネイルのみ表示中のスライドやボトムバーの押下でコンテキストメニューが出てしまうため、
  // section 全体に当てる。タッチや右クリック、iOS の長押し保存ダイアログをそもそも出さないようにする。
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const prevent = (e: Event) => e.preventDefault();
    el.addEventListener("contextmenu", prevent);
    return () => el.removeEventListener("contextmenu", prevent);
  }, []);

  const fireSkip = useCallback((clientX: number, clientY: number) => {
    const video   = videoRef.current;
    const section = sectionRef.current;
    if (!video || !section) return;
    const rect   = section.getBoundingClientRect();
    const isLeft = clientX - rect.left < rect.width / 2;
    // ユーザーが明示的にスキップしたので、画質切替の sticky resume は破棄する。
    qualitySwitchResumeRef.current = null;
    // プロ女優スキップが有効なら開始位置 (duration-60) 未満には絶対に戻らない (下限クランプ)
    const lower = skipLowerBoundRef.current;
    if (isLeft) video.currentTime = Math.max(lower, video.currentTime - SKIP_SEC);
    else        video.currentTime = Math.min(video.duration || Infinity, video.currentTime + SKIP_SEC);
    const ripple = document.createElement("div");
    ripple.className = "skip-ripple";
    ripple.style.left = `${clientX - rect.left}px`;
    ripple.style.top  = `${clientY - rect.top}px`;
    ripple.innerHTML  = `<span class="skip-icon">${isLeft ? "\u00ab -5s" : "+5s \u00bb"}</span>`;
    containerRef.current?.appendChild(ripple);
    setTimeout(() => ripple.remove(), 700);
  }, []);

  const fireTogglePlay = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      userPausedRef.current = false;
      await playVideo(video, true);
      showOverlay("play");
    } else {
      userPausedRef.current = true;
      // 一時停止と同時に minStart seek 後の play リトライ予約も破棄する。
      proActressPlayRetryPendingRef.current = false;
      if (proActressPlayFallbackTimerRef.current != null) {
        clearTimeout(proActressPlayFallbackTimerRef.current);
        proActressPlayFallbackTimerRef.current = null;
      }
      // ユーザー pause で保留 autoplay intent / watchdog も破棄する。
      pendingActiveAutoplayRef.current = null;
      if (activeAutoplayLoadKickTimerRef.current != null) {
        clearTimeout(activeAutoplayLoadKickTimerRef.current);
        activeAutoplayLoadKickTimerRef.current = null;
      }
      if (activeAutoplayWatchdogRef.current != null) {
        clearTimeout(activeAutoplayWatchdogRef.current);
        activeAutoplayWatchdogRef.current = null;
      }
      if (activeAutoplayStuckTimerRef.current != null) {
        clearTimeout(activeAutoplayStuckTimerRef.current);
        activeAutoplayStuckTimerRef.current = null;
      }
      if (activeAutoplayLoadingGraceTimerRef.current != null) {
        clearTimeout(activeAutoplayLoadingGraceTimerRef.current);
        activeAutoplayLoadingGraceTimerRef.current = null;
      }
      clearProActressSeekInFlight();
      video.pause();
      isPlayingRef.current = false;
      stopProgressLoop();
      showOverlay("pause");
    }
  }, [playVideo, showOverlay, stopProgressLoop, clearProActressSeekInFlight]);

  const handleToggleMute = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const video = videoRef.current;
    if (!video) return;
    if (isMutedRef.current) {
      globalUserGestured = true;
      globalIsMuted = false;
      video.muted = false;
      isMutedRef.current = false;
      setIsMuted(false);
      if (video.paused) {
        // 再生状態 / progress loop は play() が実際に成功してから更新する。
        // 以前は play() の解決を待たずに isPlayingRef=true + startProgressLoop()
        // していたため、play() が拒否されても「再生中」扱いになり progress loop
        // だけが空回りしていた。
        video.play().then(() => {
          isPlayingRef.current = true;
          startProgressLoop();
        }).catch(() => { /* 再生できなければ状態は据え置き (停止のまま) */ });
      }
    } else {
      globalIsMuted = true;
      video.muted = true;
      isMutedRef.current = true;
      setIsMuted(true);
    }
    window.dispatchEvent(new Event("global-mute-change"));
  }, [startProgressLoop]);

  const handleShare = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    // navigator.share はユーザージェスチャーの同期コンテキストが必要なため
    // e.preventDefault() を呼ばない
    const url = `${window.location.origin}/feed?v=${slug}`;
    const copyText = title ? `${title}\n${url}` : url;
    if (navigator.share) {
      navigator.share(title ? { title, text: title, url } : { url }).catch(() => {});
    } else {
      navigator.clipboard.writeText(copyText).catch(() => {});
    }
  }, [slug, title]);

  const handleDetail = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const video = videoRef.current;
    if (video && !video.paused) {
      userPausedRef.current = true;
      proActressPlayRetryPendingRef.current = false;
      if (proActressPlayFallbackTimerRef.current != null) {
        clearTimeout(proActressPlayFallbackTimerRef.current);
        proActressPlayFallbackTimerRef.current = null;
      }
      // detail open でも保留 autoplay intent / watchdog は破棄。
      pendingActiveAutoplayRef.current = null;
      if (activeAutoplayLoadKickTimerRef.current != null) {
        clearTimeout(activeAutoplayLoadKickTimerRef.current);
        activeAutoplayLoadKickTimerRef.current = null;
      }
      if (activeAutoplayWatchdogRef.current != null) {
        clearTimeout(activeAutoplayWatchdogRef.current);
        activeAutoplayWatchdogRef.current = null;
      }
      if (activeAutoplayStuckTimerRef.current != null) {
        clearTimeout(activeAutoplayStuckTimerRef.current);
        activeAutoplayStuckTimerRef.current = null;
      }
      if (activeAutoplayLoadingGraceTimerRef.current != null) {
        clearTimeout(activeAutoplayLoadingGraceTimerRef.current);
        activeAutoplayLoadingGraceTimerRef.current = null;
      }
      clearProActressSeekInFlight();
      video.pause();
      isPlayingRef.current = false;
      stopProgressLoop();
    }
    onOpenModal(slug);
  }, [slug, onOpenModal, stopProgressLoop, clearProActressSeekInFlight]);

  const startLongPress = useCallback(() => {
    isLongPressRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      const video = videoRef.current;
      if (!video) return;
      isLongPressRef.current = true;
      video.playbackRate = 2;
      setFastBadge(true);
    }, LONG_PRESS_MS);
  }, [setFastBadge]);

  const endLongPress = useCallback((): boolean => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    const video   = videoRef.current;
    const wasLong = isLongPressRef.current;
    if (wasLong && video) { video.playbackRate = 1; setFastBadge(false); isLongPressRef.current = false; }
    return wasLong;
  }, [setFastBadge]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!videoRef.current) return;
    isTouchDeviceRef.current = true;
    const touch = e.touches[0];
    tapStartPosRef.current = { x: touch.clientX, y: touch.clientY };
    startLongPress();
  }, [startLongPress]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!videoRef.current) return;
    const wasLong = endLongPress();
    if (wasLong) return;
    const touch = e.changedTouches[0];
    const { clientX, clientY } = touch;
    const dx = Math.abs(clientX - tapStartPosRef.current.x);
    const dy = Math.abs(clientY - tapStartPosRef.current.y);
    if (dx > TAP_MOVE_THRESHOLD || dy > TAP_MOVE_THRESHOLD) {
      tapCountRef.current = 0;
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
      return;
    }
    lastTouchEndRef.current = Date.now();
    tapCountRef.current += 1;
    if (tapCountRef.current === 1) {
      tapTimerRef.current = setTimeout(() => {
        if (tapCountRef.current === 1) fireTogglePlay();
        tapCountRef.current = 0;
      }, DBL_TAP_MS);
    } else if (tapCountRef.current >= 2) {
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
      tapCountRef.current = 0;
      fireSkip(clientX, clientY);
    }
  }, [endLongPress, fireTogglePlay, fireSkip]);

  const handleTouchCancel = useCallback(() => {
    endLongPress();
    tapCountRef.current = 0;
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
  }, [endLongPress]);

  const handleMouseDown = useCallback(() => {
    if (isTouchDeviceRef.current) return;
    startLongPress();
  }, [startLongPress]);

  const handleMouseUp = useCallback(() => {
    if (isTouchDeviceRef.current) return;
    const wasLong = endLongPress();
    if (wasLong) wasLongPressJustEndedRef.current = true;
  }, [endLongPress]);

  const handleMouseLeave = useCallback(() => {
    if (isTouchDeviceRef.current) return;
    const wasLong = endLongPress();
    if (wasLong) wasLongPressJustEndedRef.current = true;
  }, [endLongPress]);

  const handlePcClick = useCallback((e: React.MouseEvent) => {
    if (isTouchDeviceRef.current) return;
    if (Date.now() - lastTouchEndRef.current < 500) return;
    if (wasLongPressJustEndedRef.current) { wasLongPressJustEndedRef.current = false; return; }
    pcClickCountRef.current += 1;
    if (pcClickCountRef.current === 1) {
      pcClickTimerRef.current = setTimeout(() => {
        if (pcClickCountRef.current === 1) fireTogglePlay();
        pcClickCountRef.current = 0;
      }, DBL_TAP_MS);
    } else if (pcClickCountRef.current >= 2) {
      if (pcClickTimerRef.current) clearTimeout(pcClickTimerRef.current);
      pcClickCountRef.current = 0;
      fireSkip(e.clientX, e.clientY);
    }
  }, [fireTogglePlay, fireSkip]);

  return {
    videoRef,
    sectionRef,
    containerRef,
    shimmerRef,
    spinnerRef,
    fastBadgeRef,
    overlayRef,
    isMuted,
    setVideoReady,
    setShimmerVisible,
    setSpinnerVisible,
    handleToggleMute,
    handleShare,
    handleDetail,
    handleTouchStart,
    handleTouchEnd,
    handleTouchCancel,
    handleMouseDown,
    handleMouseUp,
    handleMouseLeave,
    handlePcClick,
    recoverActiveAfterForceResolve,
    noteQualitySwitch,
    applyQualitySwitchResume,
  };
}
