"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ensurePreconnect } from "@/lib/networkPrefs";
import { createVideoTimer, isVideoTimingEnabled } from "@/lib/videoTiming";

/**
 * 低画質ファースト戦略の hook (dual-video 版)。
 *
 * 動作:
 *   1. メイン <video> に `lowSrc` を渡して即時再生する (= ファーストペイント最優先)。
 *   2. lowSrc と highSrc が異なるとき、裏で hidden の高画質 <video> を full-size で
 *      マウントし、muted で同時再生する。
 *   3. 高画質側が `playing` (= 実際にデコード済みフレームを描画している状態) に到達し、
 *      かつ `currentTime` をメインに同期できた時点で、視覚的な crossfade
 *      (opacity の入れ替え) を行う。これにより `<video src>` の差し替えに伴う
 *      `emptied → loadstart → loadedmetadata → seek → playing` の再ロード待機が
 *      発生せず、ユーザーから見て「停止しないで画質が向上する」挙動になる。
 *   4. crossfade と同時に、`videoRef.current` を hidden 側 (= high) の要素に
 *      付け替える。これにより以後 `useFeedPlayback` のミュート切替・再生制御・
 *      シークなどはすべて high <video> を対象にする。低画質側は pause + opacity:0 で
 *      非表示のまま残置 (帯域は使い切らないよう src=null にして解放)。
 *
 * 安全策:
 *   - スワップは 1 つの slug あたり 1 度だけ。
 *   - low/high が同一 URL のとき (single-bitrate / 旧 API) はスワップを発火しない。
 *   - 高画質側が onError を出したらスワップを諦め、low 再生を継続する。
 *   - 高速スワイプ中はプローブを発火しない (帯域節約)。
 *   - 隣接スライド (enabled=false) ではプローブ自体を起動しない。
 *
 * 戻り値:
 *   - currentSrc: メイン (low) <video> の src に渡す URL。
 *   - highVideoSrc: hidden 高画質 <video> の src (null のときはアンマウント)。
 *   - showHigh: 高画質 <video> を可視 (opacity:1) にすべきか。これが true になった
 *     瞬間に <FeedItemVideo> 側で hidden 側の opacity を 1 に、low の opacity を 0 にする。
 *   - lowVideoCallbackRef / highVideoCallbackRef: それぞれの <video> 要素を受け取る
 *     React ref callback。受け取った要素をフックの内部 ref に保持し、必要に応じて
 *     親の `videoRef.current` をスワップする。
 *   - highProbeHandlers: 高画質 <video> に渡す onCanPlay / onPlaying / onError ハンドラ。
 */

interface Args {
  /** 低画質候補 (resolver が返した low_mp4_url)。null のときは hook はスワップを行わない。 */
  lowSrc: string | null;
  /** 高画質候補 (resolver が返した high_mp4_url)。lowSrc と同一 / null のときはスワップ不要。 */
  highSrc: string | null;
  /**
   * `useFeedPlayback` から渡される共有 video ref。
   * 初期は low <video> 要素を指し、swap 後は high <video> 要素を指すように
   * フックが `.current` を直接書き換える。
   */
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  /** 中央スライドのみスワップを発火する。隣接や Save-Data 等では false。 */
  enabled: boolean;
  /** 高速スワイプ中は false にしてプリロードを抑制する。 */
  allowPrepare: boolean;
  /**
   * slug が変わったら hook の内部状態 (スワップ済みフラグ / プローブ src) を
   * 全リセットする。同じ <video> 要素が再利用されるケースに備える。
   */
  slug: string;
  /**
   * 再生開始の最小許容秒数 (= プロ女優作品の先頭スキップ 5 秒など)。
   * 高画質 <video> を low に同期 / play() するときの currentTime を
   * この値より小さくしないようクランプする。0 / undefined のときは
   * 従来通り low の currentTime をそのまま使う。
   */
  minStartTime?: number;
  /**
   * dual-video の crossfade で `videoRef.current` を low → high に
   * 付け替えた直後に呼び出すコールバック。`useFeedPlayback` 側で
   * プロ女優スキップ / スピナー effect の deps を進めて、新しい要素に
   * イベントリスナを張り直すために使う。
   */
  onVideoElementChange?: () => void;
}

interface HighProbeHandlers {
  onCanPlay: () => void;
  onPlaying: () => void;
  onError: () => void;
  onLoadedMetadata: () => void;
}

interface Result {
  /** メイン (low) <video> の src。 */
  currentSrc: string | null;
  /** 高画質 (hidden) <video> の src。null のときはアンマウント。 */
  highVideoSrc: string | null;
  /** swap 済みかどうか (high が可視・low が非表示)。 */
  showHigh: boolean;
  /** デバッグ用 (compat)。showHigh と同義。 */
  isHigh: boolean;
  /** low <video> 要素に付ける React ref callback。 */
  lowVideoCallbackRef: (el: HTMLVideoElement | null) => void;
  /** high <video> 要素に付ける React ref callback。 */
  highVideoCallbackRef: (el: HTMLVideoElement | null) => void;
  /** high <video> に渡すイベントハンドラ。 */
  highProbeHandlers: HighProbeHandlers;
}

export function useLowFirstVideoSrc({
  lowSrc,
  highSrc,
  videoRef,
  enabled,
  allowPrepare,
  slug,
  minStartTime = 0,
  onVideoElementChange,
}: Args): Result {
  // メイン (低画質) <video> の src。 React の <video src={currentSrc}> として描画される。
  // swap 後もこの値は据え置き = 低画質 <video> は元の src のまま、ただし opacity:0 + paused。
  const [currentSrc, setCurrentSrc] = useState<string | null>(lowSrc ?? null);
  // 高画質 hidden <video> の src。null ならアンマウント。swap 完了後は null に戻して
  // メモリ・帯域を解放する。
  const [highVideoSrc, setHighVideoSrc] = useState<string | null>(null);
  // 高画質を可視化したか (crossfade 完了)。
  const [showHigh, setShowHigh] = useState(false);
  // 同じ slug について既にスワップ済みかどうか。1 度しか発火させない。
  const swappedRef = useRef(false);

  // 各 <video> 要素 (low / high) の DOM 参照。
  const lowVideoRef = useRef<HTMLVideoElement | null>(null);
  const highVideoRef = useRef<HTMLVideoElement | null>(null);

  // 「high が canplay に到達したか」「currentTime を同期したか」「再生 (playing) したか」を
  // すべて満たした時点で swap を発火するためのフラグ。
  const highReadyRef = useRef(false);
  const highSyncedRef = useRef(false);
  // 直近のシーク先 (target) 秒数。`seeked` / `timeupdate` で high.currentTime がここに
  // 到達してから swap する。プロ女優 (minStartTime>0) ケースで、0 秒のフレームが
  // crossfade の瞬間に一瞬見えるのを防ぐ。
  const highSeekTargetRef = useRef<number | null>(null);
  // high.currentTime が target を満たしているか (= 「先頭 5 秒未満」状態を抜けたか)。
  const highAtTargetRef = useRef(false);
  // dev timing 計測用: シーク開始ログを 1 回だけ出すフラグ。
  const highSeekStartLoggedRef = useRef(false);
  // 直近の slug 値。slug 変更で内部状態を全リセット。
  const lastSlugRef = useRef(slug);

  // slug が変わったら全リセット。
  // 親の videoRef.current を low <video> に戻し、次の slug で再度 low → high が走るようにする。
  // (Note: 同じ FeedItem インスタンス上で slug が変わるケースは通常無いが、念のため保険)。
  useEffect(() => {
    if (lastSlugRef.current !== slug) {
      lastSlugRef.current = slug;
      swappedRef.current = false;
      highReadyRef.current = false;
      highSyncedRef.current = false;
      highSeekTargetRef.current = null;
      highAtTargetRef.current = false;
      highSeekStartLoggedRef.current = false;
      setHighVideoSrc(null);
      setShowHigh(false);
      setCurrentSrc(lowSrc ?? null);
      // 親の共有 videoRef を low に戻す。lowVideoRef.current が null (要素未マウント)
      // のケースは、callback ref がマウント時に補完するので無視。
      if (lowVideoRef.current) {
        videoRef.current = lowVideoRef.current;
        // `useFeedPlayback` 側でリスナを新要素に張り直してもらう。
        onVideoElementChange?.();
      }
    }
  }, [slug, lowSrc, videoRef, onVideoElementChange]);

  // lowSrc が新たに resolve されたタイミングで currentSrc に反映 (初回 resolve 完了後など)。
  // swap 済みでも low video には元の src を残しておく (将来 swap 失敗時の保険) ためここでは
  // 上書きしてよい。ただし high にスワップ済みの間は low video は paused のまま。
  useEffect(() => {
    if (lowSrc && currentSrc !== lowSrc) {
      setCurrentSrc(lowSrc);
    }
  }, [lowSrc, currentSrc]);

  // 高画質 hidden <video> の起動条件:
  //   - 中央スライド (enabled)
  //   - 高速スワイプ中ではない (allowPrepare)
  //   - low と high が両方そろっていて URL が異なる
  //   - まだスワップ済みでない
  useEffect(() => {
    if (!enabled || !allowPrepare) {
      if (highVideoSrc !== null && !swappedRef.current) setHighVideoSrc(null);
      return;
    }
    if (swappedRef.current) return;
    if (!lowSrc || !highSrc || lowSrc === highSrc) {
      if (highVideoSrc !== null) setHighVideoSrc(null);
      return;
    }
    if (highVideoSrc !== highSrc) {
      setHighVideoSrc(highSrc);
    }
  }, [enabled, allowPrepare, lowSrc, highSrc, highVideoSrc]);

  // 高画質プローブが利用可能になった時点で currentTime を low に揃え、muted で play() を呼ぶ。
  // ブラウザは canplay の時点でデコード可能なので、`play()` 後すぐに `playing` が
  // 発火する想定。playing が来てから crossfade することで黒画面・停止を回避する。
  const trySyncAndPlay = useCallback(() => {
    if (swappedRef.current) return;
    const high = highVideoRef.current;
    const low = lowVideoRef.current;
    if (!high || !low) return;
    // メイン (low) の現在位置に揃える。duration を取得できていない (まだ
    // loadedmetadata 未到達) なら同期は loadedmetadata ハンドラ側で再試行する。
    // 「プロ女優」(= minStartTime > 0) 作品では low 側がまだ loadedmetadata 前で
    // currentTime が 0 付近のことがあるため、最低でも minStartTime まで持ち上げる。
    // そうしないと high <video> が 0 秒から再生し、crossfade 直後に一瞬 5 秒未満が見える。
    if (Number.isFinite(low.currentTime) && Number.isFinite(high.duration) && high.duration > 0) {
      const lowT = Number.isFinite(low.currentTime) ? low.currentTime : 0;
      // プロ女優ケースで low.currentTime が 0/未確定なら、必ず minStartTime まで持ち上げる。
      const baseline = lowT > 0 ? lowT : minStartTime;
      const desired = Math.max(minStartTime, baseline);
      const target = Math.min(desired, Math.max(0, high.duration - 0.05));
      highSeekTargetRef.current = target;
      // すでに target に到達しているなら seek 不要 (微小な差は許容)。
      if (Math.abs(high.currentTime - target) <= 0.25) {
        highAtTargetRef.current = true;
      } else {
        try {
          if (isVideoTimingEnabled() && !highSeekStartLoggedRef.current) {
            highSeekStartLoggedRef.current = true;
            // eslint-disable-next-line no-console
            console.debug(
              `vt ${slug}: high seek start target=${target.toFixed(2)} (low=${lowT.toFixed(2)} min=${minStartTime})`,
            );
          }
          high.currentTime = target;
        } catch {
          /* readyState 不足 */
        }
      }
      highSyncedRef.current = true;
    } else if (minStartTime > 0) {
      // duration がまだ取れていなくても、ベストエフォートで minStartTime にセット。
      // 一部ブラウザは loadedmetadata 前の currentTime 代入を silently accept する。
      highSeekTargetRef.current = minStartTime;
      try {
        if (isVideoTimingEnabled() && !highSeekStartLoggedRef.current) {
          highSeekStartLoggedRef.current = true;
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: high seek start (pre-metadata) target=${minStartTime}`,
          );
        }
        high.currentTime = minStartTime;
      } catch {
        /* ignore */
      }
    }
    // ミュート / playbackRate / loop / playsInline を low に合わせる。
    try {
      high.muted = low.muted;
    } catch {
      /* ignore */
    }
    try {
      high.playbackRate = low.playbackRate;
    } catch {
      /* ignore */
    }
    high.loop = low.loop;
    // 再生は low が paused でも常に開始する: crossfade 後に「ユーザーが pause していた状態」を
    // 維持するのは swapToHigh 側で行う (high.pause() を呼ぶ)。ここでは canplay→playing の
    // 遷移を確実にしておきたい。
    if (high.paused) {
      const p = high.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          /* play() が拒否されたら crossfade はしない。low 再生継続 */
        });
      }
    }
  }, [minStartTime, slug]);

  // 「ロード完了 (canplay) して、かつ playing が来ている」を満たしたタイミングで crossfade。
  // playing が来る前に crossfade すると hidden 側が黒画面を表示してしまう可能性があるため、
  // playing 待ちが安全。
  const swapToHigh = useCallback(() => {
    if (swappedRef.current) return;
    if (!enabled) return;
    if (!highSrc || !lowSrc || lowSrc === highSrc) return;

    const high = highVideoRef.current;
    const low = lowVideoRef.current;
    if (!high || !low) return;

    // low 側がまだ少なくとも 1 フレームをデコードしていない (readyState < HAVE_CURRENT_DATA)
    // と、currentTime が「これから設定される初期位置」(プロ女優の 5 秒スキップなど) を
    // 反映していない可能性がある。その状態で swap すると high が currentTime=0 から
    // 再生して見た目が一瞬戻るので、low が確実に再生フェーズに入ってからスワップする。
    // (probe 側の onPlaying / canplay が早すぎたら、ここで諦めて、後続の同イベント
    //  または loadeddata 経由の再試行で発火させる。)
    if (low.readyState < 2) {
      return;
    }

    // currentTime の同期がまだなら、最後に一度だけ試みる (まだ readyState が足りない
    // 可能性はあるが、ベストエフォート)。
    // minStartTime > 0 (= プロ女優) ケースでは low.currentTime が 0 近傍でも
    // 必ず minStartTime まで持ち上げ、5 秒スキップ仕様を crossfade 後も維持する。
    if (!highSyncedRef.current && Number.isFinite(high.duration) && high.duration > 0) {
      try {
        const lowT = Number.isFinite(low.currentTime) ? low.currentTime : 0;
        const baseline = lowT > 0 ? lowT : minStartTime;
        const desired = Math.max(minStartTime, baseline);
        const target = Math.min(desired, Math.max(0, high.duration - 0.05));
        highSeekTargetRef.current = target;
        if (Math.abs(high.currentTime - target) > 0.25) {
          high.currentTime = target;
        } else {
          highAtTargetRef.current = true;
        }
      } catch {
        /* ignore */
      }
      highSyncedRef.current = true;
    }

    // プロ女優 (minStartTime > 0) ケースでは、high が target に到達するまで swap しない。
    // - target が未確定 (duration NaN) なら、ベストエフォートで minStartTime と比較。
    // - すでに到達済み (highAtTargetRef) なら通す。
    // - currentTime が target - tolerance を下回るならまだ早い → 後続の seeked / timeupdate で
    //   再試行させる (このまま return しても、retry リスナや seeked ハンドラがリトリガする)。
    if (minStartTime > 0) {
      const target = highSeekTargetRef.current ?? minStartTime;
      const cur = Number.isFinite(high.currentTime) ? high.currentTime : 0;
      if (!highAtTargetRef.current && cur + 0.05 < target) {
        return;
      }
      highAtTargetRef.current = true;
    }

    // 低画質側の状態 (muted / playbackRate / paused) を引き継ぐ。
    const wasPaused = low.paused;
    try {
      high.muted = low.muted;
    } catch {
      /* ignore */
    }
    try {
      high.volume = low.volume;
    } catch {
      /* ignore */
    }
    try {
      high.playbackRate = low.playbackRate;
    } catch {
      /* ignore */
    }
    high.loop = low.loop;

    // crossfade を確定: 親の videoRef を high に付け替え、low を pause + 非表示にする。
    // この時点で high は既に playing しているはずなので、ユーザーから見ると
    // 「画質が良くなる以外、何も変わらない」遷移になる。
    swappedRef.current = true;
    videoRef.current = high;
    // `useFeedPlayback` 側でプロ女優スキップ / スピナーのイベントリスナを high <video> に
    // 張り直してもらう。これを呼ばないと、swap 後の high で `loadedmetadata` / `timeupdate` /
    // `seeking` / `seeked` / `ended` がトリガしなくなり、先頭 5 秒スキップやループ巻き戻り
    // が壊れる。
    onVideoElementChange?.();
    // low を停止 + ミュート (将来 src を null にする前にバッファ消費を止める)。
    try {
      low.pause();
    } catch {
      /* ignore */
    }
    // low の opacity を 0 / high の opacity を 1 にして視覚的に入れ替える。
    // React の state 更新 (setShowHigh) でも反映するが、DOM 直接書き換えも併用して
    // 確実に「next paint」で入れ替わるようにする。
    low.style.opacity = "0";
    high.style.opacity = "1";

    // 低画質側はもう不要 (帯域の二重消費を避けたい) なので src を空にして開放するが、
    // <video> 要素自体は `useFeedPlayback` の DOM 操作対象から外す必要がある。
    // ここでは src を空にせず、React state でアンマウントするのは避ける (それを
    // やると React が高画質 <video> を再マウントしかねないため)。代わりに pause だけして
    // 自然に GC に任せる。

    if (!wasPaused && high.paused) {
      const p = high.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          /* autoplay policy で拒否 → useFeedPlayback の autoplay observer 経由で復旧 */
        });
      }
    } else if (wasPaused && !high.paused) {
      try {
        high.pause();
      } catch {
        /* ignore */
      }
    }

    // React 状態を更新 (showHigh=true) — ここでスタイルクラス / aria 属性等も同期される。
    setShowHigh(true);

    if (isVideoTimingEnabled()) {
      const timer = createVideoTimer(slug);
      timer.mark("quality:high-swap");
      // eslint-disable-next-line no-console
      console.debug(
        `vt ${slug}: swap done active=high paused=${high.paused} rs=${high.readyState} lowPaused=${low.paused}`,
      );
    }

    // swap が成立した後の low <video> クリーンアップ。
    //   - これより前に切ると、もし swap がアボートした場合に「low が再生不能なまま black 画面」
    //     になる。必ず swappedRef = true / videoRef = high の確定 *後* に行う。
    //   - low はもう pause() 済み。さらに muted にして「裏で再生再開しても無音」を保証する。
    //   - src 属性を外して load() を呼び、低画質側の network/decoder/buffering を完全停止する。
    //     これで `waiting` / `stalled` / `loadeddata` 等のイベントが low から飛んでこなくなり、
    //     ローディングスピナーやサムネが low 由来で再表示されることを防ぐ。
    //   - また「プロ女優 enforce currentTime=0 -> 5」が swap 後の low から再発する経路も塞ぐ
    //     (currentTime=0 は HAVE_NOTHING の <video> でも timeupdate 経由で参照される)。
    try {
      low.pause();
    } catch { /* ignore */ }
    try {
      low.muted = true;
    } catch { /* ignore */ }
    try {
      // currentTime をリセットしておくと、後段のリスナが「currentTime=0 -> 5」を
      // 検出して enforce を再発火することを防ぎつつ、要素自体は破棄せず残せる。
      // ただし readyState が低い間は代入が黙って失敗することがあるため try/catch で十分。
      low.removeAttribute("src");
      // load() は src 除去後の状態を network/decoder に反映させる。
      // (このタイミングで emptied/loadstart は起きるが、low の vt ログのみで
      //  視覚効果はない — 既に opacity:0)
      low.load();
    } catch { /* ignore */ }

    if (isVideoTimingEnabled()) {
      // eslint-disable-next-line no-console
      console.debug(
        `vt ${slug}: low cleanup after high swap (lowPaused=${low.paused} lowMuted=${low.muted} lowHasSrc=${low.hasAttribute("src")})`,
      );
    }
  }, [enabled, highSrc, lowSrc, slug, videoRef, minStartTime, onVideoElementChange]);

  // low 側が遅れて ready になったケース用の retry。
  // probe 側で onCanPlay / onPlaying が先に発火し、swapToHigh が low.readyState < 2 で
  // 早期 return していた場合に、low が ready になったタイミングで再試行する。
  // crossfade 効果に直結する重要な経路なのでイベントベースで張る (rAF ループは避ける)。
  useEffect(() => {
    if (swappedRef.current) return;
    if (!enabled) return;
    if (!highVideoSrc) return; // probe が動いていないなら何も張らない
    const low = lowVideoRef.current;
    if (!low) return;

    const trySwap = () => {
      if (swappedRef.current) return;
      if (!highReadyRef.current) return; // high がまだ canplay/playing に到達していない
      swapToHigh();
    };

    low.addEventListener("loadeddata", trySwap);
    low.addEventListener("canplay", trySwap);
    low.addEventListener("playing", trySwap);
    low.addEventListener("seeked", trySwap);
    return () => {
      low.removeEventListener("loadeddata", trySwap);
      low.removeEventListener("canplay", trySwap);
      low.removeEventListener("playing", trySwap);
      low.removeEventListener("seeked", trySwap);
    };
  }, [enabled, highVideoSrc, swapToHigh]);

  // 高画質 <video> 側でも minStartTime を強制する。loadedmetadata / seeking / timeupdate /
  // play で currentTime < minStartTime を検知したら minStartTime に戻す。
  // crossfade 前に「0 秒のフレーム」が一瞬でも見えないように、high <video> 自身が
  // 先頭 5 秒の手前に居続けないようガードする。
  useEffect(() => {
    if (minStartTime <= 0) return;
    const high = highVideoRef.current;
    if (!high) return;

    const enforce = () => {
      if (swappedRef.current) return;
      // duration を取得済みでないと比較できない
      if (!Number.isFinite(high.duration) || high.duration <= minStartTime + 0.05) return;
      if (high.currentTime + 0.05 < minStartTime) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: pro-actress enforce element=high currentTime=${high.currentTime.toFixed(2)} -> ${minStartTime} paused=${high.paused} rs=${high.readyState} showHigh=false`,
          );
        }
        try {
          high.currentTime = minStartTime;
        } catch {
          /* ignore */
        }
      } else {
        highAtTargetRef.current = true;
      }
    };
    const onSeeked = () => {
      if (swappedRef.current) return;
      const target = highSeekTargetRef.current ?? minStartTime;
      if (Number.isFinite(high.currentTime) && high.currentTime + 0.05 >= target) {
        highAtTargetRef.current = true;
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${slug}: high seek done currentTime=${high.currentTime.toFixed(2)} target=${target.toFixed(2)}`,
          );
        }
        // target 到達後にすぐ swap を試みる (high が playing なら crossfade 即発火)。
        swapToHigh();
      } else {
        enforce();
      }
    };
    const onTimeUpdate = () => {
      if (swappedRef.current) return;
      if (!highAtTargetRef.current) {
        const target = highSeekTargetRef.current ?? minStartTime;
        if (Number.isFinite(high.currentTime) && high.currentTime + 0.05 >= target) {
          highAtTargetRef.current = true;
          // ここでも swap をリトライ (canplay→playing が target 前に来た場合の回収経路)。
          swapToHigh();
        }
      }
      enforce();
    };

    high.addEventListener("loadedmetadata", enforce);
    high.addEventListener("seeking", enforce);
    high.addEventListener("play", enforce);
    high.addEventListener("seeked", onSeeked);
    high.addEventListener("timeupdate", onTimeUpdate);
    // 初期評価
    enforce();
    return () => {
      high.removeEventListener("loadedmetadata", enforce);
      high.removeEventListener("seeking", enforce);
      high.removeEventListener("play", enforce);
      high.removeEventListener("seeked", onSeeked);
      high.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [minStartTime, slug, highVideoSrc, swapToHigh]);

  // 高画質 <video> イベントハンドラ。
  const handleProbeCanPlay = useCallback(() => {
    if (swappedRef.current) return;
    highReadyRef.current = true;
    trySyncAndPlay();
    // ブラウザによっては playing イベントが来ない (即時 paused のまま) ケースがある。
    // canplay で readyState >= HAVE_FUTURE_DATA なら crossfade してしまって良い。
    // ただし minStartTime > 0 のときは swapToHigh 内で target 未到達ならガードされる。
    const high = highVideoRef.current;
    if (high && high.readyState >= 3) {
      // HAVE_FUTURE_DATA 以上 → playing イベントを待たずに crossfade 可能
      swapToHigh();
    }
  }, [trySyncAndPlay, swapToHigh]);

  const handleProbePlaying = useCallback(() => {
    if (swappedRef.current) return;
    highReadyRef.current = true;
    swapToHigh();
  }, [swapToHigh]);

  const handleProbeLoadedMetadata = useCallback(() => {
    // duration が分かったので currentTime 同期を再試行。
    trySyncAndPlay();
  }, [trySyncAndPlay]);

  const handleProbeError = useCallback(() => {
    // 再試行はしない。ユーザーから見ると低画質のまま再生は続く。
    setHighVideoSrc(null);
    setShowHigh(false);
    // swappedRef を立てて、以降このスライドでは再起動しない。
    swappedRef.current = true;
  }, []);

  // low <video> 要素を受け取るコールバック ref。
  // 親 (useFeedPlayback) の共有 videoRef は、まだ swap していない間は low 要素を指す。
  const lowVideoCallbackRef = useCallback(
    (el: HTMLVideoElement | null) => {
      const prev = lowVideoRef.current;
      lowVideoRef.current = el;
      if (el) {
        // vt ログから「どっちの要素か」を識別できるよう dataset でタグ付け。
        try { el.dataset.vtRole = "low"; } catch { /* ignore */ }
      }
      if (!swappedRef.current) {
        videoRef.current = el;
        // null → 要素 への遷移 (= low <video> が今マウントされた) で
        // useFeedPlayback 側の effect deps を進めて自動再生を起動する。
        // resolver で lowSrc が遅延取得され、isActive=true / videoSrc=URL が
        // 揃った後にようやく <video> が DOM に挿入されるケースで、再生 effect が
        // 取りこぼされる問題への対策。
        if (el && prev !== el) {
          onVideoElementChange?.();
        }
      }
    },
    [videoRef, onVideoElementChange],
  );

  // high <video> 要素を受け取るコールバック ref。
  // swap 後は親の共有 videoRef を high 要素に付け替える。
  const highVideoCallbackRef = useCallback(
    (el: HTMLVideoElement | null) => {
      highVideoRef.current = el;
      if (el) {
        try { el.dataset.vtRole = "high"; } catch { /* ignore */ }
      }
      if (swappedRef.current && el) {
        videoRef.current = el;
      }
    },
    [videoRef],
  );

  // currentSrc に preconnect (origin の TLS を前倒しで温める)。
  useEffect(() => {
    if (currentSrc) ensurePreconnect(currentSrc);
  }, [currentSrc]);
  useEffect(() => {
    if (highVideoSrc) ensurePreconnect(highVideoSrc);
  }, [highVideoSrc]);

  return {
    currentSrc,
    highVideoSrc,
    showHigh,
    isHigh: showHigh,
    lowVideoCallbackRef,
    highVideoCallbackRef,
    highProbeHandlers: {
      onCanPlay: handleProbeCanPlay,
      onPlaying: handleProbePlaying,
      onLoadedMetadata: handleProbeLoadedMetadata,
      onError: handleProbeError,
    },
  };
}
