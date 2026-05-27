"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * フィード (`/feed` 等) からホーム / マイページ等へ `window.location.assign` で
 * フルページ遷移するとき、ブラウザが次ページの HTML を取得し終わるまで
 * 古い <video> が並ぶフィード画面がそのまま見え続け、「ボタンが効いていない」
 * 「遷移が遅い」と体感される。
 *
 * クリック直後に `nav-loading-show` イベントを受けて、ヘッダー (top) と
 * ボトムナビ (bottom) の間だけを真っ黒な背景＋スピナーで覆い、上下のバーは
 * そのまま見せ続けることで、遷移中も「ボタンが効いた」感を返す。
 *
 * - z-index は Header (100) より上、BottomNav (200) より下 (= 150)。
 * - フルページ遷移なので明示的な hide は基本不要だが、何らかの理由で遷移が
 *   発生しなかったとき (popup ブロック等) に永久に黒画面が残らないよう、
 *   `pageshow` (bfcache 復元) と `nav-loading-hide` で隠す保険を入れる。
 */
export default function NavigationLoadingOverlay() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const show = () => setVisible(true);
    const hide = () => setVisible(false);

    // 戻る/進む で bfcache から復元されたときは確実にオーバーレイを消す。
    const onPageShow = () => setVisible(false);

    window.addEventListener("nav-loading-show", show);
    window.addEventListener("nav-loading-hide", hide);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      window.removeEventListener("nav-loading-show", show);
      window.removeEventListener("nav-loading-hide", hide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  // SPA 遷移 (Next router.push / <Link>) ではフルページリロードと違って DOM が
  // 残るので、pathname が変わったら必ずオーバーレイを閉じる。フルページ遷移経路
  // (BottomNav の window.location.assign) でも pathname は新ページのものに切り替わるが、
  // その時点ではコンポーネント自体が再マウントされるため visible は初期値 false に戻る。
  useEffect(() => {
    setVisible(false);
  }, [pathname]);

  if (!visible) return null;

  return (
    <div
      className="nav-loading-overlay"
      role="status"
      aria-live="polite"
      aria-label="読み込み中"
    >
      <div className="nav-loading-overlay__spinner" aria-hidden="true" />
      <style>{css}</style>
    </div>
  );
}

declare global {
  interface WindowEventMap {
    "nav-loading-show": Event;
    "nav-loading-hide": Event;
  }
}

const css = `
  .nav-loading-overlay {
    position: fixed;
    top: var(--header-h, 52px);
    left: 0;
    right: 0;
    /*
     * BottomNav は \`bottom: -3px; height: var(--bottom-nav-h, 56px)\` で
     * 配置されているため、ナビの「視覚的な上端」は viewport_bottom から
     * 53px (= 56 - 3) の位置にある。一方で \`--bottom-nav-h\` の値そのものは
     * 56px のままなので、overlay を \`bottom: var(--bottom-nav-h)\` で置くと
     * overlay の下端 (56px) と ナビ上端 (53px) の間に 3px の隙間が出来、
     * 遷移時にその 3px だけ下のページが透けて見えて「ナビが一瞬高くなって
     * 戻る」ようにちらつく原因になっていた。
     *
     * overlay を viewport の底まで伸ばし、BottomNav の z-index (200) が
     * overlay (150) より上であることを利用してナビを上に重ねる構成にする。
     * これで \`--bottom-nav-h\` や \`bottom: -3px\` がどう変わっても隙間は出ない。
     */
    bottom: 0;
    z-index: 150;
    background: #000;
    display: flex;
    align-items: center;
    justify-content: center;
    /*
     * spinner はナビと重ならない領域 (ヘッダーとナビの間) に置きたいので、
     * overlay 自体は底まで伸びていても padding でナビ高さ分を確保する。
     */
    padding-bottom: var(--bottom-nav-h, 56px);
    /* タップを吸わせて誤操作 (連打) を防ぐ */
    touch-action: none;
    -webkit-tap-highlight-color: transparent;
  }
  .nav-loading-overlay__spinner {
    width: 36px;
    height: 36px;
    border: 3px solid rgba(255, 255, 255, 0.15);
    border-top-color: #fff;
    border-radius: 50%;
    animation: nav-loading-overlay-spin 0.8s linear infinite;
  }
  @keyframes nav-loading-overlay-spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .nav-loading-overlay__spinner { animation: none; }
  }
`;
