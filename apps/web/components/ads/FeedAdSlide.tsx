"use client";

import AdSlot from "@/components/ads/AdSlot";

interface Props {
  adIndex: number;
  isActive: boolean;
}

/**
 * フィード内広告スライド。
 * 黒背景・全画面の中央に 300x250 のモバイルバナーを表示する。
 * Recommendation Widget はレイアウトを壊すため使わない。
 *
 * --- スワイプ反応について ---
 *
 * ExoClick の配信クリエイティブはクロスオリジン iframe で描画される。
 * iframe の中で touch イベントは止まり、親 (.feed-container) のネイティブ
 * touchmove リスナーまで bubble してこないため、ユーザが広告領域を触ると
 * フィードのスワイプが反応しない問題があった。
 *
 * 修正: 広告全体に被さる透明オーバーレイ (.feed-ad-touch-shield) を置き、
 *       touch / wheel をオーバーレイで受け取って FeedViewer の native listener
 *       (bubble 経由) に届くようにする。
 *
 * トレードオフ: 広告領域上の「タップ」はオーバーレイに吸われるため、iframe
 *              内のクリエイティブが直接 click ナビゲートする経路は失われる。
 *              短押し (スワイプ未満) かつ意図的な「広告を見る」操作のために、
 *              ユーザがタップした時はオーバーレイを一瞬透過させ、次のタップで
 *              iframe にイベントが届くようにフォールバックする (二度押し方式)。
 */
export default function FeedAdSlide({ adIndex }: Props) {
  return (
    <div className="feed-ad-slide">
      <AdSlot
        zone="mobileBanner300x250"
        context={`feed-ad-${adIndex}`}
        label="広告"
        resetOnMount
      />
      {/* 透明スワイプ受けレイヤー。iframe より前面に置き、touch を親に bubble させる。 */}
      <div
        className="feed-ad-touch-shield"
        aria-hidden="true"
        onClick={(e) => {
          // タップ時はシールドを一時的に解除し、再タップで iframe に届くようにする。
          // (cross-origin iframe へ click を直接フォワードする手段は無いため二度押しで誘導)
          const el = e.currentTarget;
          el.style.pointerEvents = "none";
          window.setTimeout(() => {
            // 800ms 経過後に元の挙動 (スワイプ受け) に戻す
            el.style.pointerEvents = "";
          }, 800);
        }}
      />
      <style>{css}</style>
    </div>
  );
}

const css = `
  .feed-ad-slide {
    position: absolute;
    inset: 0;
    background: #111;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  /* iframe より前面で touch/wheel を受け取るための透明レイヤー。
     FeedViewer が縦スワイプを自前で扱うため touch-action: none にしてブラウザの
     パンを完全に止め、touch を JS にだけ届ける。 */
  .feed-ad-touch-shield {
    position: absolute;
    inset: 0;
    z-index: 5;
    background: transparent;
    touch-action: none;
    -webkit-tap-highlight-color: transparent;
  }
`;
