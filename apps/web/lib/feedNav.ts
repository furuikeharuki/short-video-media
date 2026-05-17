/**
 * ショート動画フィード (/feed) への遷移直前に立てるユーザージェスチャー由来のフラグ。
 *
 * 初回 /feed マウント時に useFeedPlayback が consumeStartUnmutedFlag() で読み取り、
 * 「ユーザー操作で /feed に来た」とみなして音声 ON で再生開始する。
 *
 * 呼び出し元 (= ユーザー操作と直結したクリックハンドラ):
 *   - BottomNav の「ショート」ボタン
 *   - HamburgerMenu の「おすすめフィード」リンク
 *   - MovieCardThumb の playlist クリック (ホーム / マイページ / 検索結果)
 *   - その他 /feed や /search/feed への遷移リンク
 */
export function markFeedStartUnmuted(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem("feed_start_unmuted", "1");
  } catch {
    /* sessionStorage 容量超過などは無視 */
  }
}
