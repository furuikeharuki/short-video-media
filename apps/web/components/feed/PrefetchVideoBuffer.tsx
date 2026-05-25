"use client";

import { useEffect, useRef } from "react";

import { isVideoTimingEnabled } from "@/lib/videoTiming";

/**
 * 動画バイトの先読み専用の <video>。
 *
 * 画面外に配置し、ユーザーには見えない。preload="auto" でブラウザの
 * 動画パイプラインに先頭バッファを取得させるのが目的。
 *
 * - muted + playsinline: モバイル Safari でも preload が走るようにする
 * - aria-hidden + tabIndex=-1: スクリーンリーダー / フォーカスから隠す
 * - pointer-events: none: 万一表示されても操作不可
 *
 * ORB (Opaque Response Blocking) 対策:
 *   - 1px / opacity:0 の隠し方だと Chrome が「メディア用途」と認識しづらく、
 *     cross-origin の MP4 が ERR_BLOCKED_BY_ORB で弾かれることがある。
 *   - 画面外 (top/left: -9999px) に普通サイズの <video> として配置することで、
 *     ブラウザにとっては「画面外にある通常のメディア要素」として preload を
 *     走らせやすくする。
 *
 * 失敗ハンドリング:
 *   - <video> が onError を発火したら親に通知し、親 hook で force=true で
 *     resolver を再呼び出しさせる。これにより、ユーザーがスワイプ到達する前に
 *     新しい URL を取得しておける。
 */

interface Props {
  slug: string;
  src: string;
  /**
   * 隠し <video> の preload 属性。
   * - "auto" (デフォルト): 通常時。先頭バッファまでバイトを取得する。
   * - "metadata": 高速スワイプ中など、中央 <video> の帯域を奪いたくないとき。
   * - "none": 完全に preload を止めたい場合。
   */
  preload?: "auto" | "metadata" | "none";
  /** dev ログ用: currentIndex からのオフセット (+1, +2 など)。 */
  offset?: number;
  /** <video> が onError を発火したら呼ばれる。fire-and-forget。 */
  onError?: (slug: string) => void;
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
  onError,
}: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  // 同じ slot の <video> で何度も onError が呼ばれても親への通知は 1 回だけにする。
  const notifiedRef = useRef(false);

  useEffect(() => {
    notifiedRef.current = false;
    const el = ref.current;
    if (!el) return;
    // preload="none" のときは load() を呼ばない (帯域を一切使わない)。
    if (preload === "none") return;

    const onLoadedMetadata = () => {
      const off = offset != null ? `+${offset}` : "?";
      vtPrefetchLog(`loadedmetadata slug=${slug} offset=${off} mode=${preload}`);
    };
    el.addEventListener("loadedmetadata", onLoadedMetadata);

    // 明示的に load() を呼んで preload を確実にキック。
    // src 属性だけ設定しても iOS Safari は load() を呼ばないと取りに行かないことがある。
    try {
      el.load();
    } catch {
      // load() が例外を投げるケースは握り潰し
    }

    return () => {
      el.removeEventListener("loadedmetadata", onLoadedMetadata);
    };
  }, [src, preload, slug, offset]);

  const handleError = () => {
    if (notifiedRef.current) return;
    notifiedRef.current = true;
    onError?.(slug);
  };

  return (
    <video
      ref={ref}
      src={src}
      preload={preload}
      muted
      playsInline
      aria-hidden="true"
      tabIndex={-1}
      onError={handleError}
      style={{
        // 画面外配置で ORB を回避しつつ、通常サイズのメディア要素として preload を起動させる。
        position: "fixed",
        top: "-9999px",
        left: "-9999px",
        width: 100,
        height: 100,
        opacity: 0,
        pointerEvents: "none",
        zIndex: -1,
      }}
    />
  );
}
