"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import AdSlot from "@/components/ads/AdSlot";

/**
 * モーダル広告を、モーダルの transform / overflow:auto コンテナの外側
 * (= document.body 直下の Portal) に独立した position:fixed の枠として描画する。
 *
 * --- なぜ別 Portal で描画するのか (PR #130 までの分析) ---
 *
 * PR #121〜#129 までモーダル内の `<ins>` に対する serve タイミング・競合 `<ins>` の
 * mask・viewport gating 等を細かく調整してきたが、ExoClick の banner.js が
 * `[Banner Debug] Visibility: hidden` で polling を止める症状が解消しなかった。
 *
 * 直接の詳細ページ (/movies/[slug] そのものを開いた場合) では同じ zone が問題なく
 * 表示されるため、変数はモーダルの「埋め込み環境」しかない。モーダル経路は次の
 * 全てを伴う:
 *   - 親 .mdm-sheet / 直接遷移時の MovieModal モーダル要素が `transform: translateY(...)`
 *     を持ち、スライドアップアニメーション中も後もずっと transform 値が乗る
 *     (translateY(0) でも matrix が乗るため、子要素は transform 含包ブロックの中になる)
 *   - そのさらに内側 .mdm-scroll は `overflow-y: auto` のスクロールコンテナで、
 *     `<ins>` は CTA の下に置かれているためモーダルを開いた直後はビューポート外
 *   - document.body は `overflow: hidden` 固定
 *
 * クロスオリジン iframe (banner.js) の自己 visibility 判定 (IntersectionObserver /
 * 自前 rect 比較) は、祖先 transform + overflow:auto + ビューポート外初期位置の
 * 組み合わせで「hidden」と誤判定し、一度 polling を止めると再開しない実装が
 * 観測されている。
 *
 * 対策: `<ins>` を *モーダルの transform / scroll 祖先の外* に出す。
 *
 * このコンポーネントは createPortal で `document.body` 直下に固定位置の wrapper を
 * 描画する。wrapper は position:fixed で常に画面下部に表示され、祖先に transform
 * は無い。banner.js の visibility 判定はこれを「画面に出ている要素」として扱う
 * ため、polling を止めずに iframe を埋めてくれる。
 *
 * 注意: 視覚的にはモーダルコンテンツの一部に見えるよう、bottom-nav の上に重なる
 * 位置に固定し、半透明の枠ではなくモーダルと同じ #0a0a0a 背景を敷いておく。
 * z-index はモーダル sheet (501) より上にし、backdrop には負けないようにする。
 */
export default function ModalAdPortal({ adKey }: { adKey: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return createPortal(
    <>
      <div className="modal-ad-portal" role="complementary" aria-label="広告">
        <AdSlot
          key={adKey}
          zone="mobileBanner300x250"
          context="modal"
          priority
          label={null}
        />
      </div>
      <style>{`
        /*
          モーダル広告枠。 mdm-sheet / MovieModal の position:fixed + transform の
          外側に独立して固定表示する。
          - position:fixed で viewport 基準に配置 (祖先 transform が無いため
            iframe の visibility 判定が "hidden" になる現象を回避)
          - bottom はモーダル下端のスクロール余白を埋めつつ、 bottom-nav が
            ある画面でもかぶらない位置に置く
          - background はモーダル本体と同じ #0a0a0a でユーザには「モーダルの
            一部」に見える
          - z-index: 502 で mdm-sheet (501) / MovieModal (101) よりわずかに上、
            ヘッダ / トースト等の上層オーバーレイは塞がない値にする
        */
        .modal-ad-portal {
          position: fixed;
          left: 0;
          right: 0;
          bottom: calc(var(--bottom-nav-h, 0px) + env(safe-area-inset-bottom, 0px));
          z-index: 502;
          display: flex;
          justify-content: center;
          padding: 12px 16px;
          background: #0a0a0a;
          box-sizing: border-box;
          pointer-events: auto;
        }
      `}</style>
    </>,
    document.body,
  );
}
