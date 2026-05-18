"use client";

import { useEffect, useRef } from "react";

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
 *   - <video> が onError を発火したら親に通知し、親 hook で
 *     1. DB の sample_movie_url を NULL に戻す (invalidateSampleUrl)
 *     2. force=true で resolver を再呼び出し
 *     をトリガーさせる。これにより、ユーザーがスワイプ到達する前に
 *     新しい URL を取得しておける。
 */

interface Props {
  slug: string;
  src: string;
  /** <video> が onError を発火したら呼ばれる。fire-and-forget。 */
  onError?: (slug: string) => void;
}

export default function PrefetchVideoBuffer({ slug, src, onError }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  // 同じ slot の <video> で何度も onError が呼ばれても親への通知は 1 回だけにする。
  const notifiedRef = useRef(false);

  useEffect(() => {
    notifiedRef.current = false;
    const el = ref.current;
    if (!el) return;
    // 明示的に load() を呼んで preload を確実にキック。
    // src 属性だけ設定しても iOS Safari は load() を呼ばないと取りに行かないことがある。
    try {
      el.load();
    } catch {
      // load() が例外を投げるケースは握り潰し
    }
  }, [src]);

  const handleError = () => {
    if (notifiedRef.current) return;
    notifiedRef.current = true;
    onError?.(slug);
  };

  return (
    <video
      ref={ref}
      src={src}
      preload="auto"
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
