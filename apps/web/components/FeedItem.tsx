"use client";

import { useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { MovieCard } from "@/lib/api/feed";
import { useBookmarks } from "@/components/auth/BookmarksProvider";
import { signIn } from "next-auth/react";
import { useFeedPlayback } from "./feed/useFeedPlayback";
import { useResolvedVideoSrc } from "./feed/useResolvedVideoSrc";
import { createVideoTimer, isVideoTimingEnabled } from "@/lib/videoTiming";
import {
  isProActressMovie,
  logProActressDecision,
} from "@/lib/proActress";
import FeedItemVideo from "./feed/FeedItemVideo";
import FeedItemMeta from "./feed/FeedItemMeta";
import FeedItemSideActions from "./feed/FeedItemSideActions";
import { itemStyle } from "./feed/feedItemStyle";
import MovieDetailModal from "./movie-detail/MovieDetailModal";
import {
  claimForFeed,
  getReadiness,
  hasPendingElement,
  hasPromotableElement,
  inspectEntry,
  markStaleClaim,
  pinSlug,
  subscribe as subscribeVideoHandoff,
  unpinSlug,
} from "@/lib/videoHandoff";
import { signalPlaying, signalUnstable } from "@/components/ads/adReadyGate";

interface Props {
  item: MovieCard;
  isActive: boolean;
  /**
   * 中央スライド (isActive) の直前/直後にマウントされている隣接スライドかどうか。
   * true のときは <video> をマウントして preload を進めるが play() はしない。
   */
  isAdjacent?: boolean;
  isFirst: boolean;
  isSecond?: boolean;
  /**
   * FeedViewer から伝えられる高速スワイプ状態。
   * true の間は隣接スライドの <video> の preload を "metadata" に弱める。
   */
  isRapidSwiping?: boolean;
  activeGenres?: string[];
  onGenreClick?: (genre: string) => void;
}

// ハードタイムアウト: <video> が loadeddata も error も発火しないまま
// これだけ経ったら、ネットワーク進行不能とみなして onError 相当のリトライを走らせる。
const VIDEO_HARD_TIMEOUT_MS = 25000;

export default function FeedItem({ item, isActive, isAdjacent = false, isFirst, isSecond = false, isRapidSwiping = false }: Props) {
  const [modalSlug, setModalSlug] = useState<string | null>(null);
  const { isAuthenticated, isBookmarked, toggle } = useBookmarks();

  // 表示する動画 URL の解決。API は high_mp4_url / low_mp4_url を返し得るが、
  // 単一 <video> 戦略では `high_mp4_url || mp4_url` のみを使う。
  const { videoSrc, exhausted, handleError, forceResolveEpoch } = useResolvedVideoSrc({
    slug: item.slug,
    enabled: isActive || isAdjacent,
    isActive,
  });

  // prefetch buffer から canplay 済み要素を引き取れたら、新規 <video> を作らずに
  // そのまま active に流用する。
  //
  // render フェーズで registry を sync 読みして「promote 可能か」を判定するため、
  // 余計な JSX <video> がマウント→即廃棄される無駄がない。claim 自体は副作用
  // (registry mutation + log) なので useLayoutEffect で行う。useLayoutEffect は
  // passive useEffect より前に走るので、同じ commit で buffer がアンマウントする
  // 場合でも先に claim できる (buffer 側の releasePrefetchElement は passive
  // cleanup として後段で走る)。
  const [promotedElement, setPromotedElement] =
    useState<HTMLVideoElement | null>(null);
  const promotedSlugRef = useRef<string | null>(null);
  // pending-handoff の状態追跡。
  //  - pendingLoggedRef: `handoff claim pending` ログを slug ごとに 1 回だけ出すため。
  //  - pendingAbandonedSlug (state): pending を諦めた slug。state にすることで
  //    canPromote 再評価による host→JSX <video> フォールバック描画をトリガーする。
  //  - activeReadyRef: 通常 active <video> が canplay/loadeddata 済みかどうか。
  //     true になった後は swap せず pending を `active-playing` で諦める。
  //  - activePlayingRef: 通常 active <video> が playing イベントを発火したかどうか。
  //     true (= 実際にフレームが進んでいる) のときに限り、late rebind を抑止する。
  //     canplay/loadeddata 単独 (activeReadyRef) では「再生可能」止まりで実際の
  //     playback が waiting/stalled で止まっている可能性があるため、pool に
  //     canplay が現れたなら rebind した方が体感の再生開始が速い。
  const pendingLoggedRef = useRef<string | null>(null);
  const [pendingAbandonedSlug, setPendingAbandonedSlug] =
    useState<string | null>(null);
  const activeReadyRef = useRef(false);
  const activePlayingRef = useRef(false);
  // force-fallback の useEffect (上の方で定義) から呼ばれる
  // abandonPendingIfActiveReady の最新参照を保持するための ref。useCallback は
  // 下の方で宣言されるため直接クロージャに取り込むと TDZ / 古い参照問題があるので、
  // 下で setup する。
  const abandonPendingIfActiveReadyRef = useRef<
    ((reason: "active-playing" | "loadeddata-ready" | "force-fallback") => void) | null
  >(null);
  // `byte-prefetch promote skipped reason=...` を slug ごとに 1 度だけ出すための ref。
  // 同 effect サイクルで複数回 tryClaim が走っても多重ログを避ける。slug が
  // 変わったら下の slug-change effect でクリアする。
  const claimMissLoggedRef = useRef<string | null>(null);
  // handoff registry の状態変化を render フェーズに伝えるためのリビジョン。
  // subscribe コールバックでこの値をインクリメントすると React が再レンダーし、
  // canPromote が再評価される。これにより:
  //   - active 化したあと遅れて pool entry が canplay に到達したケースでも、
  //     render 時点で hasPromotableElement が true となり expectingPromotion 経路で
  //     host へ rebind できる (JSX <video> が rs=0 で固まっているのを救う)。
  //   - 元々 active 化のタイミングで一度 stale-claim していた slug でも、後から
  //     canplay 到達した pool entry を late claim できる (下記 tryClaim の canplay
  //     経路は pendingAbandonedSlug ガードを通さない)。
  const [handoffRevision, setHandoffRevision] = useState(0);
  // host-only (canPromote=true) のまま promoted 要素が来ず、かつ recoverActive…
  // や no-element watchdog から force-fallback 要求が来た slug を覚える。
  // この slug については canPromote=false に倒し、JSX <video> を強制マウントする。
  // 解除は slug 変更 / 非 active 化のときに行う。
  const [forceFallbackSlug, setForceFallbackSlug] = useState<string | null>(null);
  // force-fallback が発火した回数。FeedItemVideo の key に混ぜることで
  // JSX <video> を確実に unmount→remount し、src 再 attach / load() / play() を
  // 強制する。canPromote が true→false に倒れただけでは React は同じ
  // <video> インスタンスを使い回す可能性があり、stuck な MediaElement が残る。
  const [fallbackEpoch, setFallbackEpoch] = useState(0);
  // active へ移行した時点で promotable な隠し要素があれば即時 claim する。
  // hasPromotableElement は registry を sync に読むので render フェーズで判定でき、
  // expectingPromotion=true を渡せば JSX <video> の一時マウントを完全に回避できる。
  // canplay 未到達でも pending entry があれば JSX <video> を作らず host だけを
  // 描画し、subscribe で canplay 到達を待つ (pending promote)。
  //
  // canplay 到達済みの pool entry は pendingAbandonedSlug 状態に関係なく claim 対象。
  // 「最初の active commit で一瞬 claim に失敗した slug」でも、後から pool に
  // canplay が現れたなら rebind したい。pendingAbandonedSlug は pending 経路
  // (canplay 未到達の hidden element を待つ subscribe ループ) を畳むためだけに使う。
  //
  // forceFallbackSlug が立っている slug は host-only 経路を完全に放棄して JSX
  // <video> を新規マウントする (host-only deadlock 解除)。
  const canPromote =
    isActive &&
    !!videoSrc &&
    forceFallbackSlug !== item.slug &&
    (hasPromotableElement(item.slug, videoSrc) ||
      (pendingAbandonedSlug !== item.slug &&
        hasPendingElement(item.slug, videoSrc)));
  // handoffRevision に依存させて未使用警告を避けつつ、render を registry 変化に
  // 追従させる。React は state 変化があれば自動的に再レンダーするので handoffRevision
  // を直接読む必要は無いが、明示的に参照して将来の dead-code elimination からも守る。
  void handoffRevision;
  const tryClaim = useCallback(() => {
    if (!isActive) return false;
    if (!videoSrc) return false;
    if (promotedSlugRef.current === item.slug) return true;
    // canplay 済み → 即 claim (late rebind 含む)。
    //
    // pendingAbandonedSlug ガードはここでは適用しない。理由:
    //   - 「初回 active commit の瞬間に registry エントリが流動的で claim に失敗 →
    //     setPendingAbandonedSlug(slug) → 以降 canplay pool entry が現れても
    //     tryClaim が早期 return して JSX <video> が rs=0 のまま」というデッドロックを
    //     防ぐため。後追いでも canplay pool entry が見えたなら rebind する。
    //   - ただし「現要素が実際に再生中 (playing イベント観測済み)」なら disrupt しない。
    //     activePlayingRef は playing イベントで true、isActive=false / slug 変更で false。
    if (hasPromotableElement(item.slug, videoSrc)) {
      if (activePlayingRef.current) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt byte-prefetch promote skipped slug=${item.slug} reason=already-playing`,
          );
        }
        return false;
      }
      const readiness = getReadiness(item.slug) ?? "canplay";
      const wasPending = pendingLoggedRef.current === item.slug;
      const isLateRebind = pendingAbandonedSlug === item.slug;
      // claim 直前に pin して、claimForFeed が同期実行される間に走る他経路の
      // TTL cleanup / markStaleClaim から entry を守る。pinSlug は同 src の entry が
      // registry にあるときだけ true を返す。pin に失敗した場合でも claimForFeed の
      // 結果に従う (entry が消えていれば el=null になる)。pin はこの直後 promote
      // 成功時の claimForFeed (registry.delete) で実質 no-op になるが、失敗時に
      // unpinSlug で明示解除する。
      if (!wasPending) pinSlug(item.slug, videoSrc);
      const el = claimForFeed(item.slug, videoSrc);
      if (!el) {
        // render フェーズで sync 読みした hasPromotableElement と、layout effect 内
        // の claimForFeed の間で entry が消えるレース (TTL / 別 active による
        // markStaleClaim 等)。stale 扱いで host fallback に倒し、永久に
        // thumbnail-cover で stuck するのを防ぐ。
        // 直前に建てた pin (canplay 経路の保護) も忘れず外す。
        unpinSlug(item.slug);
        pendingLoggedRef.current = null;
        markStaleClaim(item.slug, "no-entry");
        setPendingAbandonedSlug(item.slug);
        return false;
      }
      promotedSlugRef.current = item.slug;
      // late rebind に成功したのでガードを解除して、後段 (effect 再走など) で
      // canPromote / 再 claim 評価が正しく動くようにする。
      if (isLateRebind) {
        setPendingAbandonedSlug((prev) => (prev === item.slug ? null : prev));
      }
      // promote 完了 → pending pin を解除。entry は claimForFeed で registry
      // から消えているので unpinSlug は実質 no-op だが、念のため呼ぶ。
      if (wasPending) unpinSlug(item.slug);
      pendingLoggedRef.current = null;
      setPromotedElement(el);
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt byte-prefetch promote slug=${item.slug} readiness=${readiness}${
            wasPending ? " pending=true" : ""
          }${isLateRebind ? " late=true" : ""}`,
        );
        if (wasPending) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt handoff pending promote slug=${item.slug} readiness=${readiness}`,
          );
        }
        if (isLateRebind) {
          // 後追いで pool canplay entry を掴んで rebind したケースを明示。
          // 「active が rs=0 で固まっている間に隠し <video> が canplay 到達」という
          // 観測しづらいレースの追跡用。
          // eslint-disable-next-line no-console
          console.debug(
            `vt handoff late-rebind slug=${item.slug} readiness=${readiness}`,
          );
        }
      }
      return true;
    }
    // 以降の pending / stale 経路は pendingAbandonedSlug のループを止めるため依然
    // ガードする (active で一度 abandon した slug を毎回 pending pin し直す必要は
    // 無い)。
    if (pendingAbandonedSlug === item.slug) return false;
    // canplay 未到達でも pending entry があれば、subscribe で待つ。
    if (hasPendingElement(item.slug, videoSrc)) {
      // 通常 active <video> が既に再生開始可能なら swap しない方が安全。
      // ここで abandon して subscribe をやめる。
      if (activeReadyRef.current) {
        if (isVideoTimingEnabled()) {
          const readiness = getReadiness(item.slug) ?? "metadata";
          // eslint-disable-next-line no-console
          console.debug(
            `vt handoff pending abandon slug=${item.slug} reason=active-playing readiness=${readiness}`,
          );
        }
        unpinSlug(item.slug);
        pendingLoggedRef.current = null;
        setPendingAbandonedSlug(item.slug);
        return false;
      }
      // pending に入る際は registry 側に pin を立て、cap / TTL クリーンアップで
      // この entry が evict されないようにする。promote または abandon で必ず
      // unpin される。
      const wasAlreadyPending = pendingLoggedRef.current === item.slug;
      const pinned = pinSlug(item.slug, videoSrc);
      if (
        isVideoTimingEnabled() &&
        !wasAlreadyPending
      ) {
        const readiness = getReadiness(item.slug) ?? "metadata";
        // eslint-disable-next-line no-console
        console.debug(
          `vt handoff claim pending slug=${item.slug} readiness=${readiness} pinned=${pinned}`,
        );
      }
      pendingLoggedRef.current = item.slug;
      return false;
    }
    // 該当 entry が registry から消えていた / src 不一致 → 1 度だけ詳細 miss ログを出す。
    // 加えて、prefetch hook 側 (usePrefetchVideoBytes) の active-transition ログが
    // 直後に走る前に markStaleClaim を立て、`byte-prefetched=canplay` と
    // 出ているのに promote 不能だった事実を readiness window が反映できるようにする。
    // FeedItem の useLayoutEffect → usePrefetchVideoBytes の passive useEffect の
    // 順序が保証されているため、ここで mark すれば同 commit で消費される。
    const insp = inspectEntry(item.slug, videoSrc);
    let staleReason: "no-entry" | "src-mismatch" | "not-canplay";
    if (!insp.present) {
      staleReason = "no-entry";
    } else if (!insp.srcMatches) {
      staleReason = "src-mismatch";
    } else {
      staleReason = "not-canplay";
    }
    markStaleClaim(item.slug, staleReason);
    if (pendingLoggedRef.current === item.slug) {
      pendingLoggedRef.current = null;
      unpinSlug(item.slug);
      // claimForFeed が `claim miss reason=not-found|src-mismatch` を出す。
      claimForFeed(item.slug, videoSrc);
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt handoff pending abandon slug=${item.slug} reason=not-found`,
        );
      }
      setPendingAbandonedSlug(item.slug);
    } else if (claimMissLoggedRef.current !== item.slug) {
      // pending を経由しなかったケース (例: active 化の瞬間に既に entry が evict
      // 済み / src 不一致) も 1 度だけ詳細ログを残す。これが無いと「prefetch hook
      // 側は canplay と覚えているのに claim path は無言で諦めて JSX <video> を
      // ゼロから立ち上げる」状態を後追いできない。
      claimMissLoggedRef.current = item.slug;
      if (isVideoTimingEnabled()) {
        // claimForFeed の内側で `claim miss reason=...` が出るので、その理由が
        // not-found / src-mismatch / not-canplay のどれかに分かる。
        claimForFeed(item.slug, videoSrc);
        // eslint-disable-next-line no-console
        console.debug(
          `vt byte-prefetch promote skipped slug=${item.slug} reason=${staleReason}`,
        );
      }
    }
    return false;
  }, [isActive, videoSrc, item.slug, pendingAbandonedSlug]);
  // active 化 / videoSrc 解決のタイミングでまず claim を試す。
  // useLayoutEffect は passive useEffect より前に走るので、隣接 PrefetchVideoBuffer
  // の cleanup (releasePrefetchElement) より先に claim を取れる。
  useLayoutEffect(() => {
    tryClaim();
  }, [tryClaim]);
  // canplay 到達が active 化より遅れる場合 (resolve 中 / pending 中 / 初回 commit で
  // src 不一致だった等) に備え、registry の状態変化を購読して claim を再試行する。
  //
  // 加えて handoffRevision を bump して再 render させる。これにより render-phase の
  // canPromote 評価が registry の最新状態を反映し、JSX <video> が rs=0 で固まっている
  // 間に隠し element が canplay 到達したケースで expectingPromotion=true 経路に切り
  // 替えられる (= JSX <video> をアンマウントして host の promoted 要素に rebind)。
  //
  // promote 済み or 非 active なら no-op。
  useEffect(() => {
    if (!isActive) return;
    if (promotedSlugRef.current === item.slug) return;
    if (!videoSrc) return;
    const unsub = subscribeVideoHandoff(() => {
      // tryClaim を即時呼んで canplay/pending を取り込み、合わせて render を
      // 再評価させる。late rebind の対象になった slug は activePlayingRef が立つまで
      // claim 可能なので、毎回 revision を bump する。
      tryClaim();
      setHandoffRevision((n) => (n + 1) | 0);
    });
    return unsub;
  }, [isActive, videoSrc, item.slug, tryClaim]);
  // slug 変更で promoted / pending 状態を捨てる (別作品にスワイプして戻ってきた等)。
  useEffect(() => {
    if (promotedSlugRef.current && promotedSlugRef.current !== item.slug) {
      promotedSlugRef.current = null;
      setPromotedElement(null);
    }
    if (
      pendingLoggedRef.current &&
      pendingLoggedRef.current !== item.slug
    ) {
      // 別 slug を pending pin していたなら確実に解除する。
      unpinSlug(pendingLoggedRef.current);
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt handoff pending abandon slug=${pendingLoggedRef.current} reason=slug-changed`,
        );
      }
    }
    pendingLoggedRef.current = null;
    if (claimMissLoggedRef.current && claimMissLoggedRef.current !== item.slug) {
      claimMissLoggedRef.current = null;
    }
    setPendingAbandonedSlug((prev) => (prev === item.slug ? prev : null));
    // 別 slug に切り替わったら fallback フラグも捨てる (この slug の指示ではない)。
    setForceFallbackSlug((prev) => (prev === item.slug ? null : prev));
    // fallback epoch も slug 変更で 0 にリセット (epoch 単位は slug session 内)。
    setFallbackEpoch(0);
    activeReadyRef.current = false;
    activePlayingRef.current = false;
  }, [item.slug]);

  // useFeedPlayback の recoverActiveAfterForceResolve や no-element watchdog から
  // 発火される強制 fallback シグナル。自分の slug 宛なら host-only 経路を畳んで
  // JSX <video> を新規マウントさせる (canPromote=false に倒す)。
  useEffect(() => {
    if (!isActive) return;
    const onForceFallback = (e: Event) => {
      const ce = e as CustomEvent<{ slug?: string; reason?: string }>;
      if (ce.detail?.slug !== item.slug) return;
      // 同 slug に対しても遷移ごとに epoch を bump して JSX <video> を
      // 強制 remount する。canPromote=false に倒れるだけだと、React が同じ
      // 要素を再利用して src/load の再 attach が走らず host-only deadlock が
      // 解消されないケースがあった。key 経由の unmount→remount で
      // useResolvedVideoSrc の sameUrl 経路でも確実に loadstart からやり直す。
      let nextEpoch = 0;
      setFallbackEpoch((prev) => {
        nextEpoch = prev + 1;
        return nextEpoch;
      });
      setForceFallbackSlug((prev) => (prev === item.slug ? prev : item.slug));
      // remount に備えて videoReady / spinner / settled をリセットしておく。
      // 新しい <video> は loadstart からやり直すので、旧要素由来の ready 状態を
      // 引き継いではいけない。
      setVideoReadyState(false);
      activeReadyRef.current = false;
      videoSettledRef.current = false;
      activePlayingRef.current = false;
      // この slug の pending handoff entry は force-fallback で確実に放棄する。
      // 旧 host-only 経路を救うために残しても active <video> は別経路 (JSX) で
      // 動くので、pin を握り続ける意味は無い。
      // ref 経由で呼ぶことで「listener が捕まえた古い callback 参照」問題を避ける
      // (abandonPendingIfActiveReady は本 effect 以降に定義された useCallback)。
      abandonPendingIfActiveReadyRef.current?.("force-fallback");
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${item.slug}: force-fallback engaged reason=${ce.detail?.reason ?? "unknown"} epoch=${nextEpoch}`,
        );
      }
    };
    window.addEventListener("video-force-fallback", onForceFallback);
    return () => {
      window.removeEventListener("video-force-fallback", onForceFallback);
    };
  }, [isActive, item.slug]);

  // host-only deadlock 監視: isActive かつ videoSrc 解決済みかつ canPromote=true で
  // promoted 要素がまだ来ていない状態が長時間続くと、pool entry が canplay に到達
  // できない (or registry race) ことが確定的。一定時間経過しても解消しないなら
  // 自分宛に video-force-fallback を発火させて JSX <video> 経路に逃がす。
  //
  // タイムアウト値の使い分け:
  //   - canplay 済みの pool entry が存在する (hasPromotableElement=true) 場合:
  //     真の deadlock (promote 自体が何らかの理由で完了しない) なので 4 秒待つ。
  //   - pending entry しかない (hasPendingElement=true のみ) 場合:
  //     pool entry が canplay に到達するのを待っているが、active 化後 500ms 以内に
  //     canplay に到達しなければ、JSX <video> をゼロから立ち上げる方が高速。
  //     この経路で 4 秒待つと毎ページ 500ms〜1s の余計な遅延が発生する。
  //     (観測: bound=null → stale-element → host-only-deadlock の連鎖)
  //
  // 解消条件 (promotedElement set / 非 active / videoSrc 消失) は依存配列の変化で
  // 自動的に timer cleanup される。
  useEffect(() => {
    if (!isActive) return;
    if (!videoSrc) return;
    if (!canPromote) return;
    if (promotedElement) return;
    if (forceFallbackSlug === item.slug) return;
    // canplay 到達済みの pool entry がある場合は真の deadlock として長めのタイムアウト。
    // pending (canplay 未到達) のみの場合は短いタイムアウトで素早く JSX <video> に逃がす。
    const isPendingOnly =
      !hasPromotableElement(item.slug, videoSrc) &&
      hasPendingElement(item.slug, videoSrc);
    const HOST_ONLY_DEADLOCK_MS = isPendingOnly ? 1800 : 4000;
    const timer = setTimeout(() => {
      try {
        window.dispatchEvent(
          new CustomEvent("video-force-fallback", {
            detail: { slug: item.slug, reason: "host-only-deadlock" },
          }),
        );
      } catch {
        /* ignore */
      }
    }, HOST_ONLY_DEADLOCK_MS);
    return () => clearTimeout(timer);
  }, [isActive, videoSrc, canPromote, promotedElement, forceFallbackSlug, item.slug]);
  // アンマウント / 非 active 化で残った pending pin を解除する。
  // pinned entry を解放しないと、別ユーザー操作で同 slug が active になるまで
  // pool に居座り続けて cap を圧迫する。
  // 加えて、playing 観測フラグも非 active で巻き戻す (戻りスワイプで再び active
  // 化した瞬間は「まだ実体は再生してない」状態として late rebind 候補に含める)。
  useEffect(() => {
    if (isActive) return;
    activePlayingRef.current = false;
    activeReadyRef.current = false;
    // 非 active になったら abandoned flag も解除する。次に再び active になった
    // ときは新しい session として canPromote / tryClaim の評価をゼロから走らせる。
    setPendingAbandonedSlug((prev) => (prev === item.slug ? null : prev));
    // force-fallback も同様に session 単位でリセット。
    setForceFallbackSlug((prev) => (prev === item.slug ? null : prev));
    setFallbackEpoch(0);
    if (pendingLoggedRef.current === item.slug) {
      unpinSlug(item.slug);
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt handoff pending abandon slug=${item.slug} reason=inactive`,
        );
      }
      pendingLoggedRef.current = null;
    }
  }, [isActive, item.slug]);
  useEffect(() => {
    return () => {
      if (pendingLoggedRef.current) {
        unpinSlug(pendingLoggedRef.current);
        pendingLoggedRef.current = null;
      }
    };
  }, []);

  const isProActress = isProActressMovie(item.genres);

  useEffect(() => {
    if (!isActive) return;
    logProActressDecision(item.slug, item.genres);
  }, [isActive, item.slug, item.genres]);

  const [videoReady, setVideoReadyState] = useState(false);

  const hardTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoSettledRef = useRef(false);
  const clearHardTimeout = useCallback(() => {
    if (hardTimeoutRef.current) {
      clearTimeout(hardTimeoutRef.current);
      hardTimeoutRef.current = null;
    }
  }, []);

  const handleOpenModal = useCallback((slug: string) => {
    setModalSlug(slug);
  }, []);

  const handleToggleBookmark = useCallback(() => {
    if (!isAuthenticated) {
      signIn("twitter", { callbackUrl: window.location.href });
      return;
    }
    void toggle(item.id);
  }, [isAuthenticated, toggle, item.id]);

  const {
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
  } = useFeedPlayback({
    slug: item.slug,
    title: item.title,
    isActive,
    videoSrc,
    boundElement: promotedElement,
    onOpenModal: handleOpenModal,
    isProActress,
    fallbackEpoch,
  });

  // preload 戦略:
  //  - isActive (中央): 常に "auto"。中央動画の resolve / 再生は最優先。
  //  - isAdjacent (隣接) 通常時: "auto" でメディアバイトを先読み。
  //  - isAdjacent + 高速スワイプ中: "metadata" に弱める。
  //  - isFirst / isSecond の初期マウント: "auto" でファーストビューを早める。
  //  - その他: "metadata"。
  let preloadAttr: "auto" | "metadata";
  if (isActive) {
    preloadAttr = "auto";
  } else if (isAdjacent) {
    preloadAttr = isRapidSwiping ? "metadata" : "auto";
  } else if (isFirst || isSecond) {
    preloadAttr = "auto";
  } else {
    preloadAttr = "metadata";
  }

  // FeedItemVideo に渡すハンドラの identity を変えないために、変動する値は ref
  // 経由で参照する。これらの handler の identity が render ごとに変わると、
  // FeedItemVideo の adopt 用 useLayoutEffect の依存配列にぶら下がっているハンドラ
  // props も変化し、その cleanup (promotedElement.pause() / removeAttribute('src') /
  // load() / removeChild / videoRef.current = null) が走ってしまう。
  // 結果として canplay 済みの promoted <video> が rs=0 にリセットされ、次の src 同期
  // useEffect で load() が再度走り、active autoplay promote force-load → loadeddata
  // +3〜5s / canplay +5〜12s という大きな遅延が発生する。
  const forceFallbackSlugRef = useRef<string | null>(null);
  const fallbackEpochRef = useRef(0);
  const itemSlugRef = useRef(item.slug);
  const isActiveRef = useRef(isActive);
  useEffect(() => {
    forceFallbackSlugRef.current = forceFallbackSlug;
  }, [forceFallbackSlug]);
  useEffect(() => {
    fallbackEpochRef.current = fallbackEpoch;
  }, [fallbackEpoch]);
  useEffect(() => {
    itemSlugRef.current = item.slug;
  }, [item.slug]);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  const handleLoadStart = useCallback(() => {
    // ロード中のサムネ表示は thumbnail-cover で別経路。
    // force-fallback で remount された JSX <video> がここに到達したことを観測する
    // ために、fallback session 中だけ専用ログを出す。これにより
    // 「force-fallback engaged は出たが loadstart が来ない (= remount 自体に失敗)」
    // ケースが切り分けられる。
    //
    // 依存値は全部 ref から読む。ハンドラ identity は固定。
    const slug = itemSlugRef.current;
    if (forceFallbackSlugRef.current === slug && isVideoTimingEnabled()) {
      // eslint-disable-next-line no-console
      console.debug(
        `vt ${slug}: fallback video src-attached epoch=${fallbackEpochRef.current}`,
      );
    }
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
  }, [clearHardTimeout]);

  // active <video> 側で ready シグナル (loadeddata / canplay / playing) を受け取った
  // ときに pending handoff entry を解放する。`reason` 引数で「何がトリガーしたか」を
  // 明示してログに出す。これまでは全経路で `active-playing` 固定だったが、
  //   - loadeddata/canplay で abandon: まだ playing していない (loadeddata-ready)
  //   - playing で abandon: 実際に playing が観測できた (active-playing)
  //   - force-fallback で abandon: 救済 remount に伴う放棄 (force-fallback)
  // のように区別する。これによりログから「fallback 経路で playing と取り違えて
  // pending を捨ててないか」を切り分け可能になる。
  const abandonPendingIfActiveReady = useCallback(
    (reason: "active-playing" | "loadeddata-ready" | "force-fallback") => {
      if (pendingLoggedRef.current !== item.slug) return;
      unpinSlug(item.slug);
      if (isVideoTimingEnabled()) {
        const readiness = getReadiness(item.slug) ?? "metadata";
        // eslint-disable-next-line no-console
        console.debug(
          `vt handoff pending abandon slug=${item.slug} reason=${reason} readiness=${readiness}`,
        );
      }
      pendingLoggedRef.current = null;
      setPendingAbandonedSlug(item.slug);
    },
    [item.slug],
  );
  // force-fallback effect から後参照できるよう、最新を ref に流す。
  useEffect(() => {
    abandonPendingIfActiveReadyRef.current = abandonPendingIfActiveReady;
  }, [abandonPendingIfActiveReady]);

  const handleLoadedData = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    activeReadyRef.current = true;
    abandonPendingIfActiveReady("loadeddata-ready");
    setVideoReady(true);
    setVideoReadyState(true);
    setSpinnerVisible(false);
    setShimmerVisible(false);
  }, [setVideoReady, setSpinnerVisible, setShimmerVisible, clearHardTimeout, abandonPendingIfActiveReady]);

  const handleCanPlay = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    activeReadyRef.current = true;
    abandonPendingIfActiveReady("loadeddata-ready");
    setVideoReady(true);
    setVideoReadyState(true);
    setSpinnerVisible(false);
    setShimmerVisible(false);
    // 旧実装ではここで signalAdsReady() を呼んで広告 gate を解放していたが、
    // canplay は「再生可能」であって「再生が安定している」とは限らない。
    // 4G 等で canplay 直後に waiting / stalled に落ちるケースで広告 provider が
    // 動画の critical path を奪う事故を防ぐため、playing/waiting/stalled の
    // 観測ベースで gate を駆動する (下の playback-stability effect)。
  }, [setVideoReady, setSpinnerVisible, setShimmerVisible, clearHardTimeout, abandonPendingIfActiveReady]);

  const handleSeeked = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    setVideoReady(true);
    setVideoReadyState(true);
    setSpinnerVisible(false);
    setShimmerVisible(false);
  }, [setVideoReady, setSpinnerVisible, setShimmerVisible, clearHardTimeout]);

  // `playing` イベント経路。 autoplay が resolved まで進んでも canplay/loadeddata
  // が React 側に届かない (= reset useEffect で videoReadyState=false に巻き戻された
  // 後に同じ event が再発火しない) ケースで thumbnail-cover + spinner が残るのを
  // 防ぐ。promote 経路 / JSX <video> 両方で発火する。
  const handlePlaying = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    activeReadyRef.current = true;
    activePlayingRef.current = true;
    abandonPendingIfActiveReady("active-playing");
    setVideoReady(true);
    setVideoReadyState(true);
    setSpinnerVisible(false);
    setShimmerVisible(false);
  }, [setVideoReady, setSpinnerVisible, setShimmerVisible, clearHardTimeout, abandonPendingIfActiveReady]);

  // isActive を ref で参照することでハンドラ identity を安定させる。FeedItemVideo
  // の useLayoutEffect 依存配列にこのハンドラが入っており、identity 変化で cleanup
  // (promoted <video> の pause+src removal+load+detach) が走ってしまうのを防ぐ。
  const handleVideoError = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    if (!isActiveRef.current) {
      return;
    }
    handleError();
  }, [handleError, clearHardTimeout]);

  useEffect(() => {
    if (!isActive || !videoSrc) {
      clearHardTimeout();
      return;
    }
    videoSettledRef.current = false;
    clearHardTimeout();
    hardTimeoutRef.current = setTimeout(() => {
      if (!videoSettledRef.current) {
        handleVideoError();
      }
    }, VIDEO_HARD_TIMEOUT_MS);
    return clearHardTimeout;
  }, [isActive, videoSrc, handleVideoError, clearHardTimeout]);

  // useFeedPlayback の Phase 2 watchdog (active autoplay stuck) からの救済要求。
  // Phase 1 (load()+play() 直接呼び直し) でも readyState が上がらず paused のままの
  // ケースは、URL 起因 (CDN 署名期限切れ / 接続恒久切断) の可能性が高いので、
  // useResolvedVideoSrc.handleError() を呼んで force re-resolve を起こす。
  // useResolvedVideoSrc.handleError は <video> の onerror からも呼ばれるが、stuck
  // ケースでは error イベントが発火しない (= 単に Range request が永久 pending) ため
  // 明示的なシグナルが必要。
  //
  // 防御層: useFeedPlayback 側の cooldown に加えて FeedItem 側でも cooldown を
  // 持つ。force-resolve は同一 URL に対して何度走っても状態が変わらないケースが
  // あり (新 URL が同 host / 同 CDN 接続不通)、その場合 stuck→force-resolve→
  // stuck の永久ループになる。FeedItem 側 cooldown は「この slug が active で
  // ある間の連続発火」を抑え、上位 (useResolvedVideoSrc) の force retry counter と
  // backoff に処理を委ねる。
  const lastStuckRecoveryRef = useRef<{ slug: string; at: number }>({ slug: "", at: 0 });
  useEffect(() => {
    // active session が切れたら cooldown もリセットする。
    if (!isActive) {
      lastStuckRecoveryRef.current = { slug: "", at: 0 };
    }
  }, [isActive]);
  useEffect(() => {
    if (!isActive) return;
    if (!videoSrc) return;
    const onStuck = (e: Event) => {
      const ce = e as CustomEvent<{ slug?: string }>;
      if (ce.detail?.slug !== item.slug) return;
      const STUCK_RECOVERY_COOLDOWN_MS = 6000;
      const now = Date.now();
      const last = lastStuckRecoveryRef.current;
      if (last.slug === item.slug && now - last.at < STUCK_RECOVERY_COOLDOWN_MS) {
        if (isVideoTimingEnabled()) {
          // eslint-disable-next-line no-console
          console.debug(
            `vt ${item.slug}: active stuck recovery suppressed reason=cooldown delta=${now - last.at}ms`,
          );
        }
        return;
      }
      lastStuckRecoveryRef.current = { slug: item.slug, at: now };
      if (isVideoTimingEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(
          `vt ${item.slug}: active stuck recovery -> force-resolve`,
        );
      }
      handleError();
    };
    window.addEventListener("video-active-stuck", onStuck);
    return () => {
      window.removeEventListener("video-active-stuck", onStuck);
    };
  }, [isActive, videoSrc, item.slug, handleError]);

  useEffect(() => {
    setVideoReadyState(false);
    activeReadyRef.current = false;
  }, [item.slug, videoSrc]);

  // force-resolve が ready 完了して新しい URL (または同一 URL の再取得) を返したら、
  // active 要素を強制的に load()+play() リトライさせる。
  //
  // 必要な理由:
  //   - URL 文字列が同一だと FeedItemVideo の src-sync effect が早期 return し、
  //     promoted 要素は古い rs=0 のまま固まり続ける。
  //   - URL が変わっても useFeedPlayback 側の watchdog recovered/signaled latch が
  //     立っているので、後続の autoplay 経路でも recovery が再 arm されない。
  // recoverActiveAfterForceResolve は latch をクリアし、active 要素に対して直接
  // load()+play() を撃つ。force-resolve 自体のリトライ回数は useResolvedVideoSrc
  // 側で MAX_FORCE_RETRIES + 指数バックオフで上限が掛かっており、ここで cooldown
  // を重ねる必要は無い (epoch 1 増加につき 1 回 recover)。
  //
  // 注: epoch=0 (初回 resolve / slug 変更直後) では発火しない。force-resolve が
  // 1 度でも走ったあとの ready 遷移でのみトリガー。FeedItemVideo の src 同期は
  // この effect より前に走る (この effect は passive、src-sync も passive useEffect
  // だが同じ commit で発火順は React 内部の登録順依存) ため、念のため microtask に
  // 遅延させて、src が確実に書き込まれた後に recover を走らせる。
  useEffect(() => {
    if (forceResolveEpoch <= 0) return;
    if (!isActive) return;
    if (!videoSrc) return;
    const url = videoSrc;
    queueMicrotask(() => {
      recoverActiveAfterForceResolve(url);
    });
  }, [forceResolveEpoch, isActive, videoSrc, recoverActiveAfterForceResolve]);

  // 開発用: video の lifecycle 時刻を計測してログ出力する。
  useEffect(() => {
    if (!isVideoTimingEnabled()) return;
    if (!isActive) return;
    if (!videoSrc) return;
    const video = videoRef.current;
    if (!video) return;

    const timer = createVideoTimer(item.slug);
    timer.mark("video:src-attached");

    const onLoadStart = () => timer.mark("loadstart");
    const onLoadedMetadata = () => timer.mark("loadedmetadata");
    const onCanPlay = () => timer.mark("canplay");
    const onPlaying = () => timer.mark("playing");
    const onWaiting = () => timer.mark("waiting");
    const onStalled = () => timer.mark("stalled");
    const onError = () => timer.mark("error");

    video.addEventListener("loadstart", onLoadStart);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onStalled);
    video.addEventListener("error", onError);
    return () => {
      video.removeEventListener("loadstart", onLoadStart);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onStalled);
      video.removeEventListener("error", onError);
    };
  }, [isActive, videoSrc, item.slug, videoRef]);

  // 広告 gate (adReadyGate) を駆動する playback-stability observer。
  //
  // active <video> が playing に入ったら signalPlaying()、waiting / stalled /
  // error / 非 active 化したら signalUnstable() を呼ぶ。gate 側で
  // PLAYBACK_STABLE_MS の安定タイマー + idle callback による flush が行われる。
  //
  // dev-only の timing logger とは独立に常時動かす (本番でも広告 gate は必要)。
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isActive) {
      // 中央から外れた瞬間に走る。flush 予約済みなら gate 側で無視される。
      signalUnstable("inactive");
      return;
    }
    if (!videoSrc) return;
    const video = videoRef.current;
    if (!video) return;

    const onPlaying = () => {
      // active <video> が「実際にフレームを進めている」ことの確定シグナル。
      // late rebind (tryClaim の canplay 経路) はこのフラグを見て disrupt を抑止する。
      activePlayingRef.current = true;
      signalPlaying();
    };
    const onWaiting = () => signalUnstable("waiting");
    const onStalled = () => signalUnstable("stalled");
    const onError = () => signalUnstable("error");

    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("stalled", onStalled);
    video.addEventListener("error", onError);

    // active 化時点で既に playing 状態 (promoted で readyState>=3 かつ paused=false)
    // なら、playing イベントは発火しない可能性があるため明示的にトリガする。
    if (!video.paused && !video.ended && video.readyState >= 3) {
      activePlayingRef.current = true;
      signalPlaying();
    }

    return () => {
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("stalled", onStalled);
      video.removeEventListener("error", onError);
    };
  }, [isActive, videoSrc, videoRef, promotedElement]);

  const showVideo =
    (isActive || isAdjacent) && videoSrc !== null && !exhausted;

  return (
    <>
      <section ref={sectionRef} className="feed-item" data-movie-id={item.id}>
        {showVideo ? (
          <>
            <FeedItemVideo
              // fallbackEpoch を key に混ぜることで、force-fallback が engaged する
              // たびに JSX <video> を unmount→remount し src/load/play を確実に
              // 再 attach する。slug は同一 session 内なので変化させず、epoch だけ
              // で remount を制御する。epoch=0 (通常時) は単に "video-<slug>"。
              key={fallbackEpoch > 0 ? `video-${item.slug}-fb${fallbackEpoch}` : `video-${item.slug}`}
              src={videoSrc as string}
              preload={preloadAttr}
              containerRef={containerRef}
              shimmerRef={shimmerRef}
              spinnerRef={spinnerRef}
              fastBadgeRef={fastBadgeRef}
              overlayRef={overlayRef}
              videoRef={videoRef}
              thumbnailUrl={item.image_url_large ?? item.image_url_list ?? ""}
              thumbnailAlt={item.title}
              onLoadStart={handleLoadStart}
              onLoadedMetadata={handleLoadedMetadata}
              onLoadedData={handleLoadedData}
              onCanPlay={handleCanPlay}
              onSeeked={handleSeeked}
              onPlaying={handlePlaying}
              onError={handleVideoError}
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
              onTouchCancel={handleTouchCancel}
              onMouseDown={handleMouseDown}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseLeave}
              onClick={handlePcClick}
              promotedElement={promotedElement}
              expectingPromotion={canPromote && !promotedElement}
            />
            {isActive && !videoReady && (
              <div
                className="thumbnail-cover"
                aria-hidden="true"
                onContextMenu={(e) => e.preventDefault()}
              >
                <img
                  src={item.image_url_large ?? item.image_url_list ?? ""}
                  alt={item.title}
                  className="thumbnail-img"
                  loading="eager"
                  width={720}
                  height={1280}
                  draggable={false}
                  onContextMenu={(e) => e.preventDefault()}
                />
              </div>
            )}
          </>
        ) : (
          <div
            className="thumbnail-bg"
            onContextMenu={(e) => e.preventDefault()}
          >
            <img
              src={item.image_url_large ?? item.image_url_list ?? ""}
              alt={item.title}
              className="thumbnail-img"
              loading={isFirst ? "eager" : "lazy"}
              width={720}
              height={1280}
              draggable={false}
              onContextMenu={(e) => e.preventDefault()}
            />
            {isActive ? (
              <div className="overlay-wrap">
                <div
                  className="loading-spinner"
                  aria-label="動画を読み込み中"
                  style={{ display: "flex" }}
                />
              </div>
            ) : null}
          </div>
        )}

        <div className="bottom-bar">
          <FeedItemMeta item={item} />
          <FeedItemSideActions
            item={item}
            isMuted={isMuted}
            isBookmarked={isBookmarked(item.id)}
            onToggleMute={handleToggleMute}
            onToggleBookmark={handleToggleBookmark}
            onShare={handleShare}
            onDetail={handleDetail}
          />
        </div>

        <style>{itemStyle}</style>
      </section>

      {modalSlug && (
        <MovieDetailModal
          slug={modalSlug}
          onClose={() => setModalSlug(null)}
        />
      )}
    </>
  );
}
