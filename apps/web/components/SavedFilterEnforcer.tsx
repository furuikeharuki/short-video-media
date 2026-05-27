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
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { useEnforceSavedFilter } from "@/hooks/useEnforceSavedFilter";
import { SavedFilterContext, type SavedFilterStatus } from "./SavedFilterContext";

/**
 * Suspense の fallback と inner の両方に {children} を置くと、CSR bailout
 * (useSearchParams を呼ぶ Inner が suspend) → 解除のタイミングで children が
 * 別ツリー扱いになり、FeedClient が unmount → remount してしまう。
 * 結果として FeedClient 内の useState (items / isEmpty / lastFetchHadFilter / ...)
 * がリセットされ、せっかく client で fetch して 0 件と分かったあとでも
 * 「該当する作品が見つかりませんでした」表示にたどり着けない経路が生まれていた。
 *
 * 対策として:
 *   - Inner は status を計算して props/state 経由で親に伝えるだけにする
 *     (children をぶら下げない)
 *   - children は Suspense の外で 1 度だけ mount し、status は親の useState に
 *     保持して Context.Provider 経由で配下に流す
 * これにより Suspense の解除に伴う remount が発生しなくなる。
 */

function SavedFilterStatusBridge({
  setStatus,
}: {
  setStatus: (updater: (prev: SavedFilterStatus) => SavedFilterStatus) => void;
}) {
  const status = useEnforceSavedFilter();
  useEffect(() => {
    setStatus((prev) => (prev === status ? prev : status));
  }, [status, setStatus]);
  return null;
}

export default function SavedFilterEnforcer({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SavedFilterStatus>("pending");
  return (
    <SavedFilterContext.Provider value={status}>
      {/* children は Suspense の外に置く: useSearchParams を使う bridge が
          suspend しても children は影響を受けず、unmount しない。 */}
      <Suspense fallback={null}>
        <SavedFilterStatusBridge setStatus={setStatus} />
      </Suspense>
      {children}
    </SavedFilterContext.Provider>
  );
}
