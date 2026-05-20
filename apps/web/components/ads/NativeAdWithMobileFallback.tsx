"use client";

import { useEffect, useState } from "react";
import AdSlot from "@/components/ads/AdSlot";
import { AD_ZONES } from "@/lib/ads/config";

const MOBILE_MAX = 767;

type Props = {
  context?: string;
  resetOnMount?: boolean;
  className?: string;
  style?: React.CSSProperties;
  label?: string | null;
};

/**
 * 詳細ページ・モーダル・女優ページ末尾で使う広告枠。
 *
 * 経緯:
 *   ExoClick の Recommendation Widget (eas6a97888e20 / native zone) は
 *   実機スマホで内部 wrapper にインライン固定幅 (300px 等) を吐き出すため
 *   コンテナ幅まで広がらず "小さく見える" 問題が再発していた。CSS のみ /
 *   JS で DOM を書き換える対処はいずれも副作用が出てしまったため、
 *   product 側で枠ごとスイッチする方針に切り替える。
 *
 * 挙動:
 *   - 画面幅 >= 768px (PC / 大きいタブレット):
 *       既存どおり <AdSlot zone="native" /> を描画する。PC は無変更。
 *   - 画面幅 < 768px (スマホ):
 *       既知の固定 300x250 ゾーン <AdSlot zone="mobileBanner300x250" />
 *       を代わりに描画する。固定サイズのため "小さく見える" 不具合が
 *       構造的に発生しない。
 *
 * SSR では幅が不明なため、ハイドレーション完了までは何も描画しない
 * (= ハイドレーション後に 1 回だけ判定して片側だけマウントする)。
 * これにより両ゾーンへの広告呼び出しが二重に発火しない。
 *
 * mobileBanner300x250 が env で無効になっている場合は AdSlot 自身が
 * null を返すため、結果としてスマホでは広告が出ない (= 小さく見える
 * よりは無表示の方が安全) 状態になる。
 */
export default function NativeAdWithMobileFallback(props: Props) {
  const [view, setView] = useState<"desktop" | "mobile" | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(`(max-width: ${MOBILE_MAX}px)`);
    const update = () => setView(mq.matches ? "mobile" : "desktop");
    update();
    const handler = () => update();
    if (mq.addEventListener) {
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []);

  if (view === null) {
    return (
      <div
        aria-hidden
        style={{
          width: "100%",
          minHeight: AD_ZONES.native.reservedHeight ?? 0,
        }}
      />
    );
  }

  if (view === "mobile") {
    return <AdSlot {...props} zone="mobileBanner300x250" />;
  }

  return <AdSlot {...props} zone="native" />;
}
