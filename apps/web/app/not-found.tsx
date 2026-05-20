import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "404 - ページが見つかりません",
  description: "お探しのページは存在しないか、削除された可能性があります。",
  robots: { index: false, follow: false },
};

export default function NotFoundPage() {
  return (
    <main style={styles.main}>
      <div style={styles.inner}>
        <p style={styles.code}>404</p>
        <h1 style={styles.title}>ページが見つかりません</h1>
        <p style={styles.desc}>お探しのページは存在しないか、削除された可能性があります。</p>
        <Link href="/" style={styles.btn}>トップに戻る</Link>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: "100dvh",
    paddingTop: "calc(var(--header-h, 52px) + 40px)",
    paddingBottom: "var(--bottom-nav-h, 56px)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    background: "#0a0a0a",
    color: "#fff",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    boxSizing: "border-box",
  },
  inner: {
    textAlign: "center" as const,
    padding: "0 24px 48px",
  },
  code: {
    fontSize: "72px",
    fontWeight: 800,
    lineHeight: 1,
    color: "rgba(255,255,255,0.12)",
    marginBottom: "16px",
    letterSpacing: "-0.04em",
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
    marginBottom: "32px",
    lineHeight: 1.6,
  },
  btn: {
    display: "inline-block",
    padding: "12px 28px",
    background: "#e91e63",
    color: "#fff",
    borderRadius: "10px",
    fontSize: "15px",
    fontWeight: 700,
    textDecoration: "none",
  },
};
