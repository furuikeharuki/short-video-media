"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useSession } from "next-auth/react";

import {
  addBookmark,
  getBookmarkIds,
  removeBookmark,
} from "@/lib/api/me";

type BookmarksContextValue = {
  isAuthenticated: boolean;
  isBookmarked: (movieId: string) => boolean;
  toggle: (movieId: string) => Promise<boolean>;
  ids: Set<string>;
};

const BookmarksContext = createContext<BookmarksContextValue>({
  isAuthenticated: false,
  isBookmarked: () => false,
  toggle: async () => false,
  ids: new Set(),
});

export function BookmarksProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const [ids, setIds] = useState<Set<string>>(new Set());

  // ログイン状態が変わったらブックマーク一覧を取得
  useEffect(() => {
    if (status !== "authenticated") {
      setIds(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      const list = await getBookmarkIds();
      if (!cancelled) setIds(new Set(list));
    })();
    return () => {
      cancelled = true;
    };
  }, [status]);

  const isBookmarked = useCallback(
    (movieId: string) => ids.has(movieId),
    [ids],
  );

  const toggle = useCallback(
    async (movieId: string) => {
      if (status !== "authenticated") return false;
      const currentlyBookmarked = ids.has(movieId);
      // 楽観更新
      setIds((prev) => {
        const next = new Set(prev);
        if (currentlyBookmarked) next.delete(movieId);
        else next.add(movieId);
        return next;
      });
      const ok = currentlyBookmarked
        ? await removeBookmark(movieId)
        : await addBookmark(movieId);
      if (!ok) {
        // 失敗時にロールバック
        setIds((prev) => {
          const next = new Set(prev);
          if (currentlyBookmarked) next.add(movieId);
          else next.delete(movieId);
          return next;
        });
        return currentlyBookmarked;
      }
      return !currentlyBookmarked;
    },
    [status, ids],
  );

  const value = useMemo<BookmarksContextValue>(
    () => ({
      isAuthenticated: status === "authenticated",
      isBookmarked,
      toggle,
      ids,
    }),
    [status, isBookmarked, toggle, ids],
  );

  return (
    <BookmarksContext.Provider value={value}>
      {children}
    </BookmarksContext.Provider>
  );
}

export function useBookmarks() {
  return useContext(BookmarksContext);
}
