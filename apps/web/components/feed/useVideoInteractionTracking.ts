"use client";

/**
 * フィードのアクティブな <video> にイベントリスナを貼り、
 * 再生ライフサイクル系の interaction event を `/api/v1/interaction-events` に送る。
 *
 * useFeedPlayback には触らず、薄い追加レイヤとして FeedItem から呼ばれる。
 * これにより既存の autoplay / watchdog / 高速スワイプロジックには影響しない。
 *
 * 送るイベント:
 *  - play           : 実際に再生が始まった (`playing` event)。1 動画 1 回。
 *  - play_progress  : 25 / 50 / 75 % マイルストーン (1 動画 1 回ずつ)。
 *  - video_complete : 100 % 到達もしくは `ended` 発火。1 動画 1 回。
 *  - pause / resume : ユーザー操作で paused になった / 再開した。
 *  - mute / unmute  : 音量トグル (volumechange)。
 *  - replay         : ended の後に loop で先頭から再生 (timeupdate で 0 検知)。
 */

import { useEffect, useRef } from "react";

import {
  getOrCreateFeedSessionId,
  nextSessionSeq,
  trackInteraction,
  trackInteractionDeduped,
} from "@/lib/analytics/interactions";

interface Options {
  slug: string;
  videoRef: { current: HTMLVideoElement | null };
  isActive: boolean;
  /** 動画フィード内の position (動画のみで数えた index)。 */
  feedPosition?: number | null;
  surface?: string | null;
  recSource?: string | null;
}

const MILESTONES = [25, 50, 75] as const;

export function useVideoInteractionTracking({
  slug,
  videoRef,
  isActive,
  feedPosition = null,
  surface = null,
  recSource = null,
}: Options): void {
  // 「ある slug が再生開始した時刻」を覚えておき、各イベントの elapsed_ms を計算。
  const playStartAtRef = useRef<number | null>(null);
  // ended/100% を 1 回しか送らないためのラッチ。
  const completedRef = useRef(false);
  // replay 検知用: ended を見た直後の最初の "0 近辺" timeupdate を 1 回だけ replay にする。
  const sawEndedRef = useRef(false);

  useEffect(() => {
    if (!isActive) return;
    const video = videoRef.current;
    if (!video) return;

    const sessionId = getOrCreateFeedSessionId();
    const baseProps = {
      slug,
      feed_session_id: sessionId,
      feed_position: feedPosition ?? undefined,
      surface: surface ?? undefined,
      rec_source: recSource ?? undefined,
    };

    // slug が変わったら milestone state をリセット (FeedItem は slug 単位で remount される
    // が、念のため局所 state でも管理する)。
    let playLogged = false;
    completedRef.current = false;
    sawEndedRef.current = false;
    playStartAtRef.current = null;

    const elapsedMs = (): number =>
      playStartAtRef.current == null
        ? 0
        : Math.max(0, Date.now() - playStartAtRef.current);

    const onPlaying = () => {
      if (playStartAtRef.current == null) {
        playStartAtRef.current = Date.now();
      }
      if (!playLogged) {
        playLogged = true;
        trackInteractionDeduped(`play:${sessionId}:${slug}:${feedPosition ?? "-"}`, {
          event_name: "play",
          ...baseProps,
          session_seq: nextSessionSeq(),
          current_time_sec: video.currentTime,
          duration_sec: Number.isFinite(video.duration) ? video.duration : undefined,
          metadata: { muted: video.muted, volume: video.volume },
        });
      } else {
        // 2 度目以降の playing は pause からの resume として扱う。
        trackInteraction({
          event_name: "resume",
          ...baseProps,
          session_seq: nextSessionSeq(),
          current_time_sec: video.currentTime,
          duration_sec: Number.isFinite(video.duration) ? video.duration : undefined,
          elapsed_ms: elapsedMs(),
        });
      }
    };

    const onPause = () => {
      // ended → loop の自然 pause は ignore。userPause だけ送るのは難しい (event 側で
      // 判別不能) ので、currentTime > 0 で paused なら pause イベントとして記録。
      // ended が直前なら無視する。
      if (sawEndedRef.current) return;
      if (video.ended) return;
      trackInteraction({
        event_name: "pause",
        ...baseProps,
        session_seq: nextSessionSeq(),
        current_time_sec: video.currentTime,
        duration_sec: Number.isFinite(video.duration) ? video.duration : undefined,
        elapsed_ms: elapsedMs(),
      });
    };

    const onVolumeChange = () => {
      trackInteraction({
        event_name: video.muted ? "mute" : "unmute",
        ...baseProps,
        session_seq: nextSessionSeq(),
        current_time_sec: video.currentTime,
        elapsed_ms: elapsedMs(),
        metadata: { volume: video.volume, muted: video.muted },
      });
    };

    const onEnded = () => {
      sawEndedRef.current = true;
      if (completedRef.current) return;
      completedRef.current = true;
      trackInteractionDeduped(
        `complete:${sessionId}:${slug}:${feedPosition ?? "-"}`,
        {
          event_name: "video_complete",
          ...baseProps,
          session_seq: nextSessionSeq(),
          progress_ratio: 1.0,
          current_time_sec: video.currentTime,
          duration_sec: Number.isFinite(video.duration) ? video.duration : undefined,
          elapsed_ms: elapsedMs(),
        },
      );
    };

    const milestoneSent = new Set<number>();
    const onTimeUpdate = () => {
      const dur = video.duration;
      const cur = video.currentTime;
      // replay: ended 直後に currentTime が小さく戻ったら replay として送る。
      if (sawEndedRef.current && cur < 1.0) {
        sawEndedRef.current = false;
        trackInteraction({
          event_name: "replay",
          ...baseProps,
          session_seq: nextSessionSeq(),
          current_time_sec: cur,
          duration_sec: Number.isFinite(dur) ? dur : undefined,
        });
      }
      if (!Number.isFinite(dur) || dur <= 0) return;
      const ratio = cur / dur;
      for (const m of MILESTONES) {
        if (milestoneSent.has(m)) continue;
        if (ratio >= m / 100) {
          milestoneSent.add(m);
          trackInteractionDeduped(
            `pp:${sessionId}:${slug}:${feedPosition ?? "-"}:${m}`,
            {
              event_name: "play_progress",
              ...baseProps,
              session_seq: nextSessionSeq(),
              progress_milestone: m,
              progress_ratio: ratio,
              current_time_sec: cur,
              duration_sec: dur,
              elapsed_ms: elapsedMs(),
            },
          );
        }
      }
      // ended が発火しない loop 経路でも 100% に達した瞬間に video_complete を出す。
      // loop=true の場合 timeupdate の cur は wrap する前に dur に近い値を取りうる。
      if (!completedRef.current && ratio >= 0.99) {
        completedRef.current = true;
        trackInteractionDeduped(
          `complete:${sessionId}:${slug}:${feedPosition ?? "-"}`,
          {
            event_name: "video_complete",
            ...baseProps,
            session_seq: nextSessionSeq(),
            progress_ratio: 1.0,
            current_time_sec: cur,
            duration_sec: dur,
            elapsed_ms: elapsedMs(),
          },
        );
      }
    };

    // skip/seek 検知: 直近 timeupdate 時点の currentTime を覚えておき、seeked で差分を見る。
    // ±5s スキップは fireSkip がプログラム的に video.currentTime をセットして
    // seeked を発火させるため、ここで方向を取れる。loop / replay 用の seek=0 や
    // ループ復帰の微小調整 (1.5s 未満) は無視する。
    let lastTimeBeforeSeek = 0;
    const onSeeked = () => {
      const delta = video.currentTime - lastTimeBeforeSeek;
      lastTimeBeforeSeek = video.currentTime;
      if (Math.abs(delta) < 1.5) return; // ループ復帰や微小調整は無視
      if (sawEndedRef.current) return; // ended → loop の seek は replay 側で処理
      trackInteraction({
        event_name: "skip",
        ...baseProps,
        session_seq: nextSessionSeq(),
        direction: delta > 0 ? "next" : "prev",
        current_time_sec: video.currentTime,
        duration_sec: Number.isFinite(video.duration) ? video.duration : undefined,
        elapsed_ms: elapsedMs(),
        metadata: { delta_sec: Number(delta.toFixed(2)) },
      });
    };
    const onTimeUpdateForSeek = () => {
      lastTimeBeforeSeek = video.currentTime;
    };

    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("volumechange", onVolumeChange);
    video.addEventListener("ended", onEnded);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("timeupdate", onTimeUpdateForSeek);
    video.addEventListener("seeked", onSeeked);

    return () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("volumechange", onVolumeChange);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("timeupdate", onTimeUpdateForSeek);
      video.removeEventListener("seeked", onSeeked);
    };
    // videoRef の current 自体が remount で差し替わるケース (promoted element の
    // adopt/destroy など) は FeedItem 側で slug ごとに再 mount されるので、
    // ここでは isActive と slug の変化だけで張り替える。
  }, [isActive, slug, feedPosition, surface, recSource, videoRef]);
}
