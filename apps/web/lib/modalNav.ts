"use client";

/**
 * 動画詳細モーダル (MovieDetailModal) は window.history.pushState で URL バーだけを
 * /movies/<slug> に書き換えており、Next.js ルータ (usePathname) は元の /feed... を
 * 返したまま。さらにモーダル unmount 時に history.replaceState(null, "", prev) で
 * URL を元に戻す副作用がある。
 *
 * そのため、モーダル中に Next の <Link> / router.push で他ページへ遷移しようとすると:
 *   1) Next が遷移を開始
 *   2) 途中で MovieDetailModal が unmount → replaceState で URL を /feed... に戻す
 *   3) 結果として URL は /feed... のまま、ページも /feed のままになり遷移できない
 *
 * 回避策: 実 URL バー (window.location.pathname) が /movies/ で始まっているとき
 * (= モーダル中) はフルページ遷移 window.location.assign を使う。
 * React の unmount 処理が走らないため、ブラウザがそのまま遷移先に移動する。
 *
 * ActressLink がこの仕組みを最初に導入し、本ヘルパーで共通化した。
 */
export function isInMovieModal(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.pathname.startsWith("/movies/");
}

/**
 * モーダル中であればフルページ遷移、それ以外であれば spaNavigate (router.push 等) を実行する。
 */
export function navigateRespectingModal(href: string, spaNavigate: () => void): void {
  if (isInMovieModal()) {
    window.location.assign(href);
    return;
  }
  spaNavigate();
}
