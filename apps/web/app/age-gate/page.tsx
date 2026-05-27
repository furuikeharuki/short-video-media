import AgeGateForm from "@/components/analytics/age-gate-form";
import type { Metadata } from "next";

// /age-gate は本来ユーザー向けの中継ページであって独立した検索対象ではない。
// 万一クローラ UA バイパス (middleware.ts) をすり抜けて Google が age-gate を
// 取得しても、ホーム "/" の重複ページとして扱わせ、検索結果に
// "年齢確認 | AV Shorts | AV Shorts" のような title が出続けることを防ぐ。
// - robots: noindex,nofollow で除外する
// - canonical を "/" に向けて、もし index されてもホーム扱いにする
// - og:title もホームと同じサイト名にして、age-gate の文言を SERP の見出しに
//   採用されにくくする
export const metadata: Metadata = {
  title: "年齢確認",
  description: "AV Shorts は18歳以上を対象としたアダルトコンテンツを含みます。年齢確認のうえご利用ください。",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
      "max-snippet": -1,
      "max-image-preview": "none",
    },
  },
  alternates: { canonical: "/" },
  openGraph: {
    title: "AV Shorts",
    url: "/",
  },
};

type AgeGatePageProps = {
  searchParams: Promise<{
    next?: string;
  }>;
};

// オープンリダイレクト防止: next は同一オリジン内の相対パスに限定する。
// "/" で始まり "//" や "/\" で始まらないものだけ許可。query string と
// fragment はそのまま温存する (例: "/feed?q=巨乳" は OK、"//evil.com" は NG)。
function sanitizeNextPath(raw: string | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

export default async function AgeGatePage({ searchParams }: AgeGatePageProps) {
  const params = await searchParams;
  const nextPath = sanitizeNextPath(params.next);

  return (
    <main style={styles.main}>
      <div style={styles.bg} aria-hidden="true" />

      <div style={styles.card}>
        <div style={styles.iconWrap} aria-hidden="true">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#e91e63" strokeWidth="1.5">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        </div>

        {/* ロゴ */}
        <div style={{ marginBottom: "16px" }}>
          <span style={{ fontSize: "22px", fontWeight: 800, letterSpacing: "-0.02em" }}>
            <span style={{ color: "#e91e63" }}>AV</span>
            <span style={{ color: "#fff" }}> Shorts</span>
          </span>
        </div>

        <h1 style={styles.title}>年齢確認</h1>
        <p style={styles.subtitle}>このサイトは<strong style={styles.strong}>18歳以上対象</strong>のアダルトコンテンツを含みます。</p>
        <p style={styles.sub2}>下のボタンを押すことで、あなたが18歳以上であることを確認したことになります。</p>

        <AgeGateForm nextPath={nextPath} />

        <div style={styles.divider} />

        <a
          href="https://www.google.com"
          target="_blank"
          rel="noopener noreferrer"
          style={styles.exitLink}
        >
          18歳未満の方はこちら
        </a>

        <p style={styles.legal}>
          同意することで、当サイトのプライバシーポリシーおよび利用規約に同意したものとみなします。
        </p>
      </div>

      <style>{css}</style>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: '100dvh',
    background: '#0a0a0a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px 16px',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  bg: {
    position: 'fixed',
    inset: 0,
    background: 'radial-gradient(ellipse at 50% 0%, rgba(233,30,99,0.15) 0%, transparent 65%)',
    pointerEvents: 'none',
    zIndex: 0,
  },
  card: {
    position: 'relative',
    zIndex: 1,
    width: '100%',
    maxWidth: '400px',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '20px',
    padding: '40px 32px',
    textAlign: 'center',
    backdropFilter: 'blur(12px)',
  },
  iconWrap: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '72px',
    height: '72px',
    borderRadius: '50%',
    background: 'rgba(233,30,99,0.12)',
    marginBottom: '20px',
  },
  title: {
    fontSize: '24px',
    fontWeight: 700,
    color: '#fff',
    marginBottom: '12px',
  },
  subtitle: {
    fontSize: '15px',
    color: 'rgba(255,255,255,0.7)',
    lineHeight: 1.7,
    marginBottom: '8px',
  },
  strong: {
    color: '#fff',
    fontWeight: 600,
  },
  sub2: {
    fontSize: '13px',
    color: 'rgba(255,255,255,0.4)',
    lineHeight: 1.7,
    marginBottom: '28px',
  },
  divider: {
    height: '1px',
    background: 'rgba(255,255,255,0.08)',
    margin: '24px 0',
  },
  exitLink: {
    display: 'block',
    fontSize: '13px',
    color: 'rgba(255,255,255,0.35)',
    textDecoration: 'none',
    marginBottom: '20px',
  },
  legal: {
    fontSize: '11px',
    color: 'rgba(255,255,255,0.2)',
    lineHeight: 1.7,
  },
};

const css = `
  .age-gate-form-btn {
    display: block;
    width: 100%;
    padding: 15px;
    background: #e91e63;
    color: #fff;
    font-size: 16px;
    font-weight: 700;
    border: none;
    border-radius: 12px;
    cursor: pointer;
    min-height: 52px;
    transition: opacity 0.15s ease, transform 0.15s ease;
  }
  .age-gate-form-btn:hover { opacity: 0.88; }
  .age-gate-form-btn:active { opacity: 0.75; transform: scale(0.98); }
`;
