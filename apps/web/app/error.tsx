"use client";

import { useEffect } from "react";
import Link from "next/link";

type ErrorPageProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main style={styles.main}>
      <div style={styles.inner}>
        <p style={styles.code}>⚠️</p>
        <h1 style={styles.title}>エラーが発生しました</h1>
        <p style={styles.desc}>ページの表示中に問題が発生しました。</p>
        {error.message && (
          <p style={styles.errorMsg}>{error.message}</p>
        )}
        <div style={styles.actions}>
          <button
            type="button"
            onClick={() => reset()}
            style={styles.retryBtn}
          >
            もう一度試す
          </button>
          <Link href="/" style={styles.homeBtn}>トップに戻る</Link>
        </div>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    position: "fixed" as const,
    top: "52px",
    left: 0,
    right: 0,
    bottom: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#0a0a0a",
    color: "#fff",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  inner: {
    textAlign: "center" as const,
    padding: "24px",
    maxWidth: "400px",
    width: "100%",
  },
  code: {
    fontSize: "56px",
    lineHeight: 1,
    marginBottom: "16px",
  },
  title: {
    fontSize: "22px",
    fontWeight: 700,
    marginBottom: "12px",
    color: "#fff",
  },
  desc: {
    fontSize: "14px",
    color: "rgba(255,255,255,0.45)",
    marginBottom: "12px",
    lineHeight: 1.6,
  },
  errorMsg: {
    fontSize: "12px",
    color: "rgba(255,255,255,0.25)",
    marginBottom: "28px",
    fontFamily: "monospace",
    wordBreak: "break-all" as const,
  },
  actions: {
    display: "flex",
    gap: "10px",
    justifyContent: "center" as const,
    flexWrap: "wrap" as const,
  },
  retryBtn: {
    padding: "12px 24px",
    background: "rgba(255,255,255,0.12)",
    border: "1px solid rgba(255,255,255,0.25)",
    color: "#fff",
    borderRadius: "10px",
    fontSize: "15px",
    fontWeight: 700,
    cursor: "pointer",
    transition: "opacity 0.15s ease",
  },
  homeBtn: {
    display: "inline-block",
    padding: "12px 24px",
    background: "#e91e63",
    color: "#fff",
    borderRadius: "10px",
    fontSize: "15px",
    fontWeight: 700,
    textDecoration: "none",
    transition: "opacity 0.15s ease",
  },
};
