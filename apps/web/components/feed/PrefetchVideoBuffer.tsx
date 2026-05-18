"use client";

import { useEffect, useRef } from "react";

/**
 * 動画バイトの先読み専用の <video>。
 *
 * 画面外 (1px) に配置し、ユーザーには見えない。preload="auto" でブラウザの
 * 動画パイプラインに先頭バッファを取得させるのが目的。
 *
 * - muted + playsinline: モバイル Safari でも preload が走るようにする
 *   (autoplay は禁止。ここでは load() だけ呼び、再生は本物の <video> に任せる)
 * - aria-hidden + tabIndex=-1: スクリーンリーダー / フォーカスから隠す
 * - pointer-events: none: 万一表示されても操作不可
 */

interface Props {
  src: string;
}

export default function PrefetchVideoBuffer({ src }: Props) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
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

  return (
    <video
      ref={ref}
      src={src}
      preload="auto"
      muted
      playsInline
      aria-hidden="true"
      tabIndex={-1}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: 1,
        height: 1,
        opacity: 0,
        pointerEvents: "none",
        zIndex: -1,
      }}
    />
  );
}
