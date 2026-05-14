import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "特定商取引法に基づく表記 | AVShorts",
  description: "AVShorts の特定商取引法に基づく表記ページです。",
};

export default function LawPage() {
  return (
    <main style={styles.main}>
      <div style={styles.container}>
        <nav style={styles.nav}>
          <Link href="/" style={styles.backLink}>← トップへ戻る</Link>
        </nav>

        <h1 style={styles.h1}>特定商取引法に基づく表記</h1>
        <p style={styles.updated}>最終更新日：2026年5月14日</p>

        <table style={styles.table}>
          <tbody>
            <Row label="販売業者">
              <p>各販売事業者（FANZA等）</p>
            </Row>
            <Row label="所在地">
              <p>開示請求があった場合、遅滞なく提供いたします。</p>
            </Row>
            <Row label="メールアドレス">
              <a href="mailto:avshorts0512@gmail.com" style={styles.link}>avshorts0512@gmail.com</a>
            </Row>
            <Row label="運営責任者">
              <p>開示請求があった場合、遅滞なく提供いたします。</p>
            </Row>
            <Row label="サイトURL">
              <p>{process.env.NEXT_PUBLIC_SITE_URL ?? "本サイト"}</p>
            </Row>
            <Row label="役務の内容">
              <p>アダルトコンテンツのアフィリエイト紹介サービス。当サイトは販売者ではなく、FANZAアフィリエイトプログラムを通じた成果報酬型広告を運営しています。</p>
            </Row>
            <Row label="対価以外に必要な費用">
              <p>通信費（インターネット接続料金）はお客様のご負担となります。</p>
            </Row>
            <Row label="支払い方法">
              <p>当サイトでは販売を行っていません。購入は各販売事業者（FANZA等）のサイトにてお手続きください。</p>
            </Row>
            <Row label="商品の引渡し時期">
              <p>当サイトでの販売はありません。各販売事業者の規約に準じます。</p>
            </Row>
            <Row label="返品・キャンセル">
              <p>当サイトでの販売はありません。各販売事業者の返品・キャンセルポリシーに準じます。</p>
            </Row>
            <Row label="年齢制限">
              <p>本サービスは18歳以上の方を対象としています。18歳未満の方の利用はお断りしています。</p>
            </Row>
            <Row label="プライバシーポリシー">
              <Link href="/privacy" style={styles.link}>プライバシーポリシーはこちら</Link>
            </Row>
          </tbody>
        </table>

        <p style={styles.note}>
          ※ 本サイトはFANZA（株式会社デジタルコマース）のアフィリエイトプログラム「DMM アフィリエイト」に参加しています。
          当サイトに掲載されているリンクを経由してご購入いただいた場合、当サイトに成果報酬が支払われることがあります。
        </p>
      </div>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr style={styles.tr}>
      <th style={styles.th}>{label}</th>
      <td style={styles.td}>{children}</td>
    </tr>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: "100dvh",
    background: "#0a0a0a",
    color: "#e0e0e0",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  container: {
    maxWidth: "720px",
    margin: "0 auto",
    padding: "32px 24px 64px",
  },
  nav: {
    marginBottom: "24px",
  },
  backLink: {
    color: "#aaa",
    textDecoration: "none",
    fontSize: "14px",
  },
  h1: {
    fontSize: "clamp(20px, 5vw, 28px)" as unknown as string,
    fontWeight: 700,
    marginBottom: "8px",
    color: "#fff",
  },
  updated: {
    fontSize: "13px",
    color: "#666",
    marginBottom: "40px",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    marginBottom: "32px",
  },
  tr: {
    borderBottom: "1px solid rgba(255,255,255,0.08)",
  },
  th: {
    textAlign: "left",
    verticalAlign: "top",
    padding: "16px 12px 16px 0",
    fontSize: "13px",
    fontWeight: 600,
    color: "#aaa",
    whiteSpace: "nowrap",
    width: "160px",
  },
  td: {
    padding: "16px 0",
    fontSize: "14px",
    lineHeight: 1.8,
    color: "#ccc",
  },
  link: {
    color: "#e91e63",
    textDecoration: "underline",
  },
  note: {
    fontSize: "12px",
    lineHeight: 1.8,
    color: "#555",
    borderTop: "1px solid rgba(255,255,255,0.06)",
    paddingTop: "24px",
  },
};
