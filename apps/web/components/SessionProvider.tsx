"use client";

import { SessionProvider as NextAuthSessionProvider } from "next-auth/react";
import type { ReactNode } from "react";

import { BookmarksProvider } from "@/components/auth/BookmarksProvider";

export default function SessionProvider({ children }: { children: ReactNode }) {
  return (
    <NextAuthSessionProvider>
      <BookmarksProvider>{children}</BookmarksProvider>
    </NextAuthSessionProvider>
  );
}
