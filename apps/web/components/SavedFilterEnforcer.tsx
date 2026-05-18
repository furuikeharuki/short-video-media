"use client";

/**
 * /feed と /search 配下にいるときに、保存済みフィルター (sessionStorage / DB) を
 * URL クエリへ自動的に注入する透明コンポーネント。
 *
 * useSearchParams() を使うので Next.js 15 では Suspense バウンダリが必要 (CSR bailout 対策)。
 * ルートレイアウト側で <SavedFilterEnforcer /> を一度だけ置く。
 */
import { Suspense } from "react";
import { useEnforceSavedFilter } from "@/hooks/useEnforceSavedFilter";

function SavedFilterEnforcerInner() {
  useEnforceSavedFilter();
  return null;
}

export default function SavedFilterEnforcer() {
  return (
    <Suspense fallback={null}>
      <SavedFilterEnforcerInner />
    </Suspense>
  );
}
