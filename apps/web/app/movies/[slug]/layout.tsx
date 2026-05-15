"use client";

import { useEffect } from "react";

export default function MovieDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    document.body.classList.add("detail-page");
    return () => {
      document.body.classList.remove("detail-page");
    };
  }, []);

  return <>{children}</>;
}
