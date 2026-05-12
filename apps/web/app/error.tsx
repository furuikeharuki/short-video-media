"use client";

import { useEffect } from "react";

type ErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main style={{ padding: "24px", maxWidth: "720px", margin: "0 auto" }}>
      <h1>エラーが発生しました</h1>
      <p>ページの表示中に問題が発生しました。</p>
      <p style={{ color: "#666" }}>{error.message}</p>

      <button
        type="button"
        onClick={() => reset()}
        style={{
          marginTop: "16px",
          padding: "10px 16px",
          border: "1px solid #ddd",
          borderRadius: "8px",
          background: "#fff",
          cursor: "pointer",
        }}
      >
        もう一度試す
      </button>
    </main>
  );
}