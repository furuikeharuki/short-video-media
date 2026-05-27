import {
  BOTTOM_NAV_FREEZE_KEY,
  BOTTOM_NAV_FREEZE_TTL_MS,
} from "@/lib/bottomNavFreeze";

/**
 * Chrome 限定のフルページ遷移チラつきを抑えるための「first-paint より前」処理。
 *
 * 仕組み:
 *   1. BottomNav 内のリンクをタップしてフルページ遷移を起こす瞬間、離脱側で
 *      sessionStorage に「直前の active な href」を書き出す
 *      (lib/bottomNavFreeze.ts)。
 *   2. 着地ページの HTML が届くと、この <script> が React のハイドレーション
 *      より前に同期実行され、sessionStorage を読んで <html> に
 *      `data-nav-freeze-active-href="..."` を付ける。
 *   3. globals.css 側のセレクタがその属性を見て:
 *      - 「スナップショット時にアクティブだった項目」を強制的にアクティブ表示
 *      - 「実際の新 pathname でアクティブな項目」のアクティブ表示を抑制
 *      - シークバー (opacity / レール) を消す
 *      - `bottom: -3px` を `bottom: 0` に差し替えてサブピクセル位置の揺らぎを消す
 *      これで「新ページの first paint」が「離脱直前の見た目」と完全一致する。
 *   4. ハイドレーション完了 + 2 フレーム後にこのスクリプトが属性を外し、
 *      本来の active state / シークバーへ自然に戻す。同じフレーム内で
 *      React state を変えるわけではないのでハイドレーションミスマッチは起きない。
 *
 * BottomNav の React 側ロジック (pathname → isActive 判定) は一切変更しない。
 * よってサーバ HTML と React のハイドレーション結果は常に一致する。
 */
export default function BottomNavFreezeBootstrap() {
  // インラインスクリプトとして、ハイドレーション以前に同期実行する。
  // dangerouslySetInnerHTML を使うのは、Next.js が <script> の中身を子要素として
  // 流すと文字列エスケープが入って構文を壊す可能性があるため。
  const script = `
(function(){
  try {
    var raw = sessionStorage.getItem(${JSON.stringify(BOTTOM_NAV_FREEZE_KEY)});
    if (!raw) return;
    var snap = null;
    try { snap = JSON.parse(raw); } catch (e) { snap = null; }
    sessionStorage.removeItem(${JSON.stringify(BOTTOM_NAV_FREEZE_KEY)});
    if (!snap || typeof snap.activeHref !== 'string' || typeof snap.ts !== 'number') return;
    if (Date.now() - snap.ts > ${BOTTOM_NAV_FREEZE_TTL_MS}) return;
    var root = document.documentElement;
    root.setAttribute('data-nav-freeze-active-href', snap.activeHref);
    // 2 フレーム + 微小ディレイで属性を外す。
    // - 1 フレーム目: スナップショットの見た目で paint される
    // - 2 フレーム目: そのまま固定。Chrome の compositing レイヤが完全に
    //   落ち着くタイミング (ナビが安定した GPU レイヤとして昇格し終わる)
    // - その後属性除去 → CSS transition により active state / seekbar が
    //   自然にフェード。ナビ自体の geometry/位置は変えていないので揺れない。
    var unfreeze = function(){
      try { root.removeAttribute('data-nav-freeze-active-href'); } catch (e) {}
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function(){
        requestAnimationFrame(function(){
          // 一拍置いて (フレーム後の microtask が落ち着くタイミング) 解除。
          setTimeout(unfreeze, 80);
        });
      });
    } else {
      setTimeout(unfreeze, 160);
    }
    // 何らかの理由 (タブ非表示/エラー) で RAF が起動しない場合に備えた保険。
    setTimeout(unfreeze, ${BOTTOM_NAV_FREEZE_TTL_MS});
  } catch (e) { /* ignore */ }
})();
`;
  return (
    <script
      // 同期実行が必要なので async/defer は付けない。
      dangerouslySetInnerHTML={{ __html: script }}
    />
  );
}
