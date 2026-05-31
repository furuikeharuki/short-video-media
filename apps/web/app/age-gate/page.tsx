import AgeGateForm from "@/components/analytics/age-gate-form";
import NextScreenPreview from "@/components/age-gate/NextScreenPreview";
import AgeGateExitLink from "@/components/age-gate/AgeGateExitLink";
import { sanitizeNextPath, classifyNextPath } from "@/lib/age-gate/next-path";
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

export default async function AgeGatePage({ searchParams }: AgeGatePageProps) {
  const params = await searchParams;
  // next はクライアントが書き換え可能なため必ずサニタイズする (オープン
  // リダイレクト防止)。同一オリジンの内部パス以外は "/" にフォールバックする。
  const nextPath = sanitizeNextPath(params.next);
  const nextKind = classifyNextPath(nextPath);

  return (
    <main style={styles.main}>
      {/* 次の画面の気配を背後にうっすら見せる (内容はロードしない汎用スケルトン)。 */}
      <NextScreenPreview kind={nextKind} />

      {/* age-gate カードの可読性を上げるための暗幕。preview と同様に不活性。 */}
      <div style={styles.scrim} aria-hidden="true" />
      <div style={styles.bg} aria-hidden="true" />

      <div style={styles.card} role="dialog" aria-modal="true" aria-labelledby="age-gate-title">
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

        <h1 id="age-gate-title" style={styles.title}>年齢確認</h1>
        <p style={styles.subtitle}>このサイトは<strong style={styles.strong}>18歳以上対象</strong>のアダルトコンテンツを含みます。</p>

        {/* 不安軽減コピー: 登録不要・無料で続きが見られることを明示して離脱を抑える。 */}
        <ul style={styles.reassure} aria-label="ご利用にあたって">
          <li style={styles.reassureItem}>会員登録なし・無料でそのまま視聴できます</li>
          <li style={styles.reassureItem}>確認後はご覧になっていたページに戻ります</li>
        </ul>

        <AgeGateForm nextPath={nextPath} nextKind={nextKind} />

        <p style={styles.sub2}>ボタンを押すと、あなたが18歳以上であることを確認したものとみなします。</p>

        <div style={styles.divider} />

        <AgeGateExitLink />

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
  scrim: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(10,10,10,0.62)',
    pointerEvents: 'none',
    zIndex: 0,
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
    fontSize: '12px',
    color: 'rgba(255,255,255,0.4)',
    lineHeight: 1.7,
    marginTop: '12px',
    marginBottom: '4px',
  },
  reassure: {
    listStyle: 'none',
    padding: 0,
    margin: '0 0 24px',
    textAlign: 'left',
    display: 'inline-block',
  },
  reassureItem: {
    fontSize: '13px',
    color: 'rgba(255,255,255,0.7)',
    lineHeight: 1.9,
    paddingLeft: '22px',
    position: 'relative',
  },
  divider: {
    height: '1px',
    background: 'rgba(255,255,255,0.08)',
    margin: '24px 0',
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
  .age-gate-form-btn:focus-visible {
    outline: 3px solid rgba(233,30,99,0.6);
    outline-offset: 2px;
  }
  ul[aria-label="ご利用にあたって"] li::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0.55em;
    width: 12px;
    height: 7px;
    border-left: 2px solid #e91e63;
    border-bottom: 2px solid #e91e63;
    transform: rotate(-45deg);
  }
`;
