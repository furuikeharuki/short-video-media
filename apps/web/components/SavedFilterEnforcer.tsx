"use client";

/**
 * /feed と /search 配下にいるときに、保存済みフィルター (sessionStorage / DB) を
 * URL クエリへ自動的に注入する透明コンポーネント。
 *
 * 加えて、配下 (children) に対して「enforce 処理中か / 確定済みか」を Context で
 * 共有する。これにより /feed と /search のコンテンツ側は、pending の間は
 * スピナー表示にしてフィルター違反作品のフラッシュを防げる。
 *
 * useSearchParams() を使うので Next.js 15 では Suspense バウンダリが必要 (CSR bailout 対策)。
 * ルートレイアウト側で <SavedFilterEnforcer>{children}</SavedFilterEnforcer> で包む。
 */
import { Suspense, type ReactNode } from "react";
import { useEnforceSavedFilter } from "@/hooks/useEnforceSavedFilter";
import { SavedFilterContext } from "./SavedFilterContext";

function SavedFilterEnforcerInner({ children }: { children: ReactNode }) {
  const status = useEnforceSavedFilter();
  return (
    <SavedFilterContext.Provider value={status}>
      {children}
    </SavedFilterContext.Provider>
  );
}

export default function SavedFilterEnforcer({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<SavedFilterContext.Provider value="pending">{children}</SavedFilterContext.Provider>}>
      <SavedFilterEnforcerInner>{children}</SavedFilterEnforcerInner>
    </Suspense>
  );
}
