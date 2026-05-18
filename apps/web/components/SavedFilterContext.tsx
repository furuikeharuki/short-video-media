"use client";

/**
 * SavedFilterEnforcer の「URL 確定状態」を子コンポーネント (FeedClient / SearchInfiniteGrid) に
 * 共有するための Context。
 *
 * - "pending":  /feed や /search に来た直後、まだ saved pref を読んで URL に注入するか
 *               判断が終わっていない状態。コンテンツ側はこの間スピナー表示にして
 *               「フィルター違反の作品が一瞬見えてから正しい結果に置き換わる」フラッシュを防ぐ。
 * - "ready":    enforce 処理が完了し、URL が確定した状態。SSR/CSR で表示している
 *               結果がそのままユーザーの最終的なフィルターと一致している。
 *
 * 状態遷移は SavedFilterEnforcer が更新し、ここから配下のクライアントが購読する。
 */
import { createContext, useContext } from "react";

export type SavedFilterStatus = "pending" | "ready";

export const SavedFilterContext = createContext<SavedFilterStatus>("ready");

/**
 * /feed や /search の中で「enforce が終わるのを待ってからコンテンツを描画したい」
 * クライアントが使う。pending の間は loading 表示にして、ready になったら本来の
 * 描画ロジックに進む、というガードに使う。
 */
export function useSavedFilterStatus(): SavedFilterStatus {
  return useContext(SavedFilterContext);
}
