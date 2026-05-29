"use client";

import { useEffect, useRef } from "react";

import { isVideoTimingEnabled } from "@/lib/videoTiming";
import {
  registerPrefetchElement,
  releasePrefetchElement,
  updateReadiness,
} from "@/lib/videoHandoff";

/**
 * 動画バイトの先読み専用の <video>。
 *
 * 実装方式 (PR #181 以降):
 *   - <video> を React の JSX としてではなく、`document.createElement("video")`
 *     で作って videoHandoff レジストリに登録する。これにより、active 側 (FeedItem)
 *     が canplay 済みの要素を claim して同一の DOM ノードをそのまま流用できる。
 *   - 本コンポーネント自体は host <div> を 1 つマウントするだけ。要素は host に
 *     append される。
 *   - 画面外配置 (top/left: -9999px) は registerPrefetchElement 側でセット済み。
 *   - 失敗 (error) は onError 経由で親 hook (usePrefetchVideoBytes) に通知し、
 *     force=true で resolver を再呼び出しさせる。
 */

interface Props {
  slug: string;
  src: string;
  preload?: "auto" | "metadata" | "none";
  /**
   * dev ログ用: スロット作成時点での currentIndex からのオフセット。
   * active が遠ざかっても "作成時の offset" を保持するため、ここで受け取る値は
   * 親 (usePrefetchVideoBytes) が slot を生成した瞬間に固定したものを渡す。
   */
  offset?: number;
  /**
   * 再生開始秒数 (= pro-actress 作品の先頭スキップ秒数)。0 / undefined は
   * ノーマルケース。registry に渡され、loadedmetadata 後に
   * `<video>.currentTime` にセットされて、browser が minStart 付近の Range も
   * 裏で取得するように誘導する。これにより active 化時の seek が即 canplay まで
   * 進むようになり、`pro-actress seek deadline extend` ループを回避する。
   */
  minStart?: number;
  onError?: (slug: string) => void;
  onMetadata?: (slug: string) => void;
  onCanPlay?: (slug: string) => void;
}

function vtPrefetchLog(message: string) {
  if (!isVideoTimingEnabled()) return;
  // eslint-disable-next-line no-console
  console.debug(`vt byte-prefetch ${message}`);
}

export default function PrefetchVideoBuffer({
  slug,
  src,
  preload = "auto",
  offset,
  minStart,
  onError,
  onMetadata,
  onCanPlay,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // 同じ slot の <video> で何度も onError が呼ばれても親への通知は 1 回だけにする。
  const notifiedRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    notifiedRef.current = false;
    if (preload === "none") {
      return;
    }

    const el = registerPrefetchElement({ slug, src, preload, minStart });
    host.appendChild(el);

    const offLabel = offset != null ? `+${offset}` : "?";
    let canPlayNotified = false;

    const onLoadedMetadata = () => {
      vtPrefetchLog(
        `loadedmetadata slug=${slug} offset=${offLabel} mode=${preload}`,
      );
      updateReadiness(slug, "metadata");
      onMetadata?.(slug);
    };
    const onCanPlayHandler = () => {
      if (canPlayNotified) return;
      canPlayNotified = true;
      vtPrefetchLog(`canplay slug=${slug} offset=${offLabel} mode=${preload}`);
      updateReadiness(slug, "canplay");
      onCanPlay?.(slug);
    };
    const onErrorHandler = () => {
      if (notifiedRef.current) return;
      notifiedRef.current = true;
      onError?.(slug);
    };
    el.addEventListener("loadedmetadata", onLoadedMetadata);
    el.addEventListener("canplay", onCanPlayHandler);
    el.addEventListener("error", onErrorHandler);

    // src 変更前に既に十分バッファ済みのケース (back-to-back swap など) を拾う。
    if (el.readyState >= 3) {
      onCanPlayHandler();
    } else if (el.readyState >= 1) {
      updateReadiness(slug, "metadata");
      onMetadata?.(slug);
    }

    return () => {
      el.removeEventListener("loadedmetadata", onLoadedMetadata);
      el.removeEventListener("canplay", onCanPlayHandler);
      el.removeEventListener("error", onErrorHandler);
      // claim 済みの場合は releasePrefetchElement が no-op になる。
      releasePrefetchElement(slug, el);
    };
  }, [src, preload, slug, offset, minStart, onMetadata, onCanPlay, onError]);

  // host だけ React で管理する。実 <video> 要素は registerPrefetchElement が作る。
  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        top: "-9999px",
        left: "-9999px",
        width: 0,
        height: 0,
        pointerEvents: "none",
      }}
    />
  );
}
