"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type { MovieCard } from "@/lib/api/feed";
import { reportSampleUrl } from "@/lib/api/sample-url";
import { probeSampleUrls } from "@/lib/sampleUrlProbe";
import { useBookmarks } from "@/components/auth/BookmarksProvider";
import { signIn } from "next-auth/react";
import { useFeedPlayback } from "./feed/useFeedPlayback";
import FeedItemVideo from "./feed/FeedItemVideo";
import FeedItemMeta from "./feed/FeedItemMeta";
import FeedItemSideActions from "./feed/FeedItemSideActions";
import { itemStyle } from "./feed/feedItemStyle";
import MovieDetailModal from "./movie-detail/MovieDetailModal";

interface Props {
  item: MovieCard;
  isActive: boolean;
  isFirst: boolean;
  isSecond?: boolean;
  activeGenres?: string[];
  onGenreClick?: (genre: string) => void;
}

// DMM のサンプル動画 URL は content_id の表記 (ゼロパディング有無) と
// MP4 ファイル名の suffix でパターンが規則化されているが、作品によって
// どの組み合わせが使われているかが違うため、クライアント側で順番に試して見つける。
//
// 例: mmmb00181 -> mmmb181 (CDN 上はパディング無し), scop00912 -> scop912 etc.
//      一部の作品はパディング有りの URL で配信されているため、両方試す。
const MP4_SUFFIXES = ["_mhb_w.mp4", "mhb.mp4", "_dmb_w.mp4", "dmb.mp4"] as const;

// 数字部の先頭のゼロを削る。
// mmmb00181 -> mmmb181 / scop00912 -> scop912 / 1sun00054a -> 1sun54a / host00001 -> host1
function stripPad(cid: string): string {
  // 先頭の数字、中央の英字、数字、末尾の英字 (任意) を拾う
  const m = cid.match(/^(\d*)([a-zA-Z_]+)(\d+)([a-zA-Z]?)$/);
  if (!m) return cid;
  const [, prefixNum, alpha, num, tail] = m;
  const stripped = String(parseInt(num, 10));
  return `${prefixNum}${alpha}${stripped}${tail}`;
}

// litevideo/freepv URL をパースして cid を取り出し、別の suffix / パディング
// バリエーションでフォールバック URL を生成する。
function parseSampleUrl(url: string): { cid: string; suffix: string } | null {
  const m = url.match(/\/litevideo\/freepv\/[a-z0-9_]\/[a-z0-9_]+\/([a-zA-Z0-9_]+)\/\1((?:_mhb_w|mhb|_dmb_w|dmb)\.mp4)$/);
  if (!m) return null;
  return { cid: m[1], suffix: m[2] };
}

// 先頭の数字 prefix を削る。 1sun54a -> sun54a / 59hez892 -> hez892
function stripNumPrefix(cid: string): string {
  return cid.replace(/^\d+/, "");
}

function buildSampleUrl(cid: string, suffix: string): string {
  const lower = cid.toLowerCase();
  // CDN パスの prefix に使う cid は先頭の数字を除いたもの。
  const cidForPath = lower.replace(/^\d+/, "");
  if (!cidForPath || !/^[a-z]/.test(cidForPath)) return "";
  const c0 = cidForPath[0];
  const c3 = cidForPath.slice(0, 3);
  return `https://cc3001.dmm.co.jp/litevideo/freepv/${c0}/${c3}/${lower}/${lower}${suffix}`;
}

// content_id からパディングを 4 桁・5 桁で試す。
// DMM の作品表記は 4 桁 (mmmb0181) や 5 桁 (mmmb00181) が混在するため、両方試す。
function zeroPadCid(cid: string, width: number): string {
  const m = cid.match(/^(\d*)([a-zA-Z_]+)(\d+)([a-zA-Z]?)$/);
  if (!m) return cid;
  const [, prefixNum, alpha, num, tail] = m;
  return `${prefixNum}${alpha}${num.padStart(width, "0")}${tail}`;
}

// フォールバック候補 URL の全リストを生成。candidates[0] は常にオリジナル URL。
// cid の表記 (パディング有無/数字prefix有無) × suffix の全組み合わせ。
function buildSampleUrlCandidates(url: string, contentId: string | null): string[] {
  const parsed = parseSampleUrl(url);
  if (!parsed) return [url];
  const { suffix: origSuffix, cid: origCid } = parsed;

  // DB 上の content_id を起点に cid バリエーションを組み立てる。
  // パターン:
  //   - content_id そのまま (例: mmmb00181, 1sun00054a)
  //   - 4 桁ゼロパディング (mmmb0181)
  //   - 5 桁ゼロパディング (mmmb00181)
  //   - ゼロパディング無し (mmmb181)
  //   - 数字prefix 除去× 上記各パターン
  const cid = (contentId || "").toLowerCase();
  const noNum = stripNumPrefix(cid);
  const cidVariants = new Set<string>();
  for (const base of [cid, noNum]) {
    if (!base) continue;
    cidVariants.add(base);
    cidVariants.add(stripPad(base));
    cidVariants.add(zeroPadCid(base, 4));
    cidVariants.add(zeroPadCid(base, 5));
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (u: string) => {
    if (u && !seen.has(u)) {
      seen.add(u);
      candidates.push(u);
    }
  };
  // まずはオリジナル URL を 0 番目に入れておく (重複チェックのため)
  addCandidate(url);
  // suffix を先に試してから cid variant を換える (同じ cid で suffix 違いのほうがヒットしやすい)
  for (const suf of MP4_SUFFIXES) {
    if (suf === origSuffix) continue;
    addCandidate(buildSampleUrl(origCid, suf));
  }
  for (const variant of cidVariants) {
    if (variant === origCid) continue;
    for (const suf of MP4_SUFFIXES) {
      addCandidate(buildSampleUrl(variant, suf));
    }
  }
  return candidates;
}

// フォールバック候補 URL を生成。cid の表記 (パディング有無/数字prefix有無) × suffix の全組み合わせを試す。
function switchSuffix(url: string, attemptIndex: number, contentId: string | null): string | null {
  if (attemptIndex <= 0) return null;
  const candidates = buildSampleUrlCandidates(url, contentId);
  return candidates[attemptIndex] ?? null;
}

// フォールバック試行回数の上限 (cid variants 最大 8 種× suffix 4 種 = 最大32 候補)
const MAX_MP4_ATTEMPTS = 32;

// ハードタイムアウト: これだけ待っても loadedmetadata も error も発火しなければ
// 「ロードしっぱなしで試した URL が無効」とみなしてフォールバックを起動する。
// DMM CDN が 403/404 を返す代わりに、コネクションを保持したまま応答を返さないケースでも
// ユーザーが「いくら待っても再生されない」状態に陥らないようにするためのセーフティネット。
const VIDEO_HARD_TIMEOUT_MS = 8000;

export default function FeedItem({ item, isActive, isFirst, isSecond = false }: Props) {
  const [modalSlug, setModalSlug] = useState<string | null>(null);
  // サンプル動画 URL のフォールバック試行回数 (0 = オリジナル)
  const [mp4Attempt, setMp4Attempt] = useState(0);
  // プローブで見つけた有効 URL (見つかったらこちらを使う)
  const [probedUrl, setProbedUrl] = useState<string | null>(null);
  // プローブを二重起動しないためのガード
  const probeInFlightRef = useRef(false);
  const probeExhaustedRef = useRef(false);
  // <video> がロード中のままスタックしたときに強制的にエラーハンドラを取り込むためのタイマー
  const hardTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 現在の <video> に対してもう loadedmetadata / error が発火したかどうか
  const videoSettledRef = useRef(false);
  const { isAuthenticated, isBookmarked, toggle } = useBookmarks();

  const handleOpenModal = useCallback((slug: string) => {
    setModalSlug(slug);
  }, []);

  const handleToggleBookmark = useCallback(() => {
    if (!isAuthenticated) {
      // 未ログインのときは Twitter ログインを促す (主要プロバイダをデフォルトに)
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
  } = useFeedPlayback({
    slug: item.slug,
    title: item.title,
    isActive,
    onOpenModal: handleOpenModal,
  });

  const preloadAttr = isFirst || isSecond ? "auto" : "metadata";

  // 表示する動画 URL の優先順:
  //   1. プローブで見つけた有効 URL (probedUrl)
  //   2. 直列フォールバックの現在位置 (mp4Attempt > 0)
  //   3. オリジナル URL (item.sample_movie_url)
  const videoSrc = (() => {
    if (probedUrl) return probedUrl;
    if (!item.sample_movie_url) return null;
    if (mp4Attempt === 0) return item.sample_movie_url;
    return switchSuffix(item.sample_movie_url, mp4Attempt, item.content_id ?? "") ?? item.sample_movie_url;
  })();

  const clearHardTimeout = useCallback(() => {
    if (hardTimeoutRef.current) {
      clearTimeout(hardTimeoutRef.current);
      hardTimeoutRef.current = null;
    }
  }, []);

  const handleVideoError = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    if (!item.sample_movie_url) return;
    // オリジナル URL で初回エラーが起きたとき:
    //   残りの候補を並列プローブして一気に当たり URL を見つける。
    //   これで初回ユーザーもフォールバック 32 回分を待たずに済む。
    if (!probeExhaustedRef.current && !probeInFlightRef.current && !probedUrl) {
      probeInFlightRef.current = true;
      const all = buildSampleUrlCandidates(item.sample_movie_url, item.content_id ?? "");
      // すでに試してダメだったオリジナル URL を除外
      const remaining = all.slice(1);
      if (remaining.length > 0) {
        void probeSampleUrls(remaining, { concurrency: 4, timeoutMs: 4000 }).then((found) => {
          probeInFlightRef.current = false;
          if (found) {
            setProbedUrl(found);
          } else {
            // プローブが全部ダメだったケース: この作品はどの URL も存在しないとみなして
            // サムネ表示にフォールバックさせる (mp4Attempt を上限まで進める)。
            // プローブは buildSampleUrlCandidates と同じ候補を使うので、
            // 直列フォールバックも全部ダメなのは明らか。
            probeExhaustedRef.current = true;
            setMp4Attempt(MAX_MP4_ATTEMPTS);
          }
        });
        return;
      }
    }

    // プローブ中: 何もせずにプローブの結果を待つ (同時に直列フォールバックを走らせない)
    if (probeInFlightRef.current) {
      return;
    }
    // probed URL もダメだった or プローブが全滑した → サムネイルに落とす
    if (probedUrl || probeExhaustedRef.current) {
      setMp4Attempt(MAX_MP4_ATTEMPTS);
      return;
    }
  }, [item.sample_movie_url, item.content_id, probedUrl, clearHardTimeout]);

  // videoSrc が変わるたびにハードタイムアウトをセットし直す。
  // VIDEO_HARD_TIMEOUT_MS 以内に loadedmetadata / error が発火しないと
  // 強制的に handleVideoError を呼んでフォールバックを進める。
  useEffect(() => {
    if (!isActive || !videoSrc) {
      clearHardTimeout();
      return;
    }
    videoSettledRef.current = false;
    clearHardTimeout();
    hardTimeoutRef.current = setTimeout(() => {
      if (!videoSettledRef.current) {
        // タイムアウト発火: handleVideoError と同じフォールバック経路を取る
        handleVideoError();
      }
    }, VIDEO_HARD_TIMEOUT_MS);
    return clearHardTimeout;
  }, [isActive, videoSrc, handleVideoError, clearHardTimeout]);

  // 動画が再生可能になったとき、オリジナル URL 以外 (プローブで見つけた or
  // 直列フォールバックで見つけた) で成功した場合は API に報告して DB にキャッシュさせる。
  // 次回以降はキャッシュ済み URL がフィードに乗るためプローブも不要になる。
  const handleLoadedData = useCallback(() => {
    videoSettledRef.current = true;
    clearHardTimeout();
    setVideoReady(true);
    // 初回ロードが完了したらスピナーも一旦消す。その後は waiting/playing イベントで制御される。
    setSpinnerVisible(false);
    const isFallback = probedUrl !== null || mp4Attempt > 0;
    if (isFallback && videoSrc && item.slug && videoSrc !== item.sample_movie_url) {
      void reportSampleUrl(item.slug, videoSrc);
    }
  }, [setVideoReady, setSpinnerVisible, mp4Attempt, probedUrl, videoSrc, item.slug, item.sample_movie_url, clearHardTimeout]);

  // フォールバックを使い果たしたかどうか
  const isMp4Exhausted = mp4Attempt >= MAX_MP4_ATTEMPTS;
  // 中央のスライド (isActive=true) だけ <video> を描画する。
  // 隣接スライドはサムネイルのみ表示して、同時に複数の
  // <video> 読み込みが走らないようにする。これでモバイル Safari の
  // 同時接続上限・帯域競合を避け、再生開始までの時間を短縮できる。
  const showVideo = isActive && videoSrc && !isMp4Exhausted;

  return (
    <>
      <section ref={sectionRef} className="feed-item" data-movie-id={item.id}>
        {showVideo ? (
          <FeedItemVideo
            src={videoSrc}
            preload={preloadAttr}
            containerRef={containerRef}
            shimmerRef={shimmerRef}
            spinnerRef={spinnerRef}
            fastBadgeRef={fastBadgeRef}
            overlayRef={overlayRef}
            videoRef={videoRef}
            thumbnailUrl={item.image_url_large ?? item.image_url_list ?? ""}
            thumbnailAlt={item.title}
            onLoadedData={handleLoadedData}
            onCanPlay={() => { setVideoReady(true); setSpinnerVisible(false); }}
            onError={handleVideoError}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchCancel}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
            onClick={handlePcClick}
          />
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
