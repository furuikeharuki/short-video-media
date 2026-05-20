import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "プライバシーポリシー",
  description:
    "AV Shorts のプライバシーポリシー。当サイトにおける個人情報・Cookieの取り扱いについて記載しています。",
  alternates: { canonical: "/privacy" },
  openGraph: {
    title: "プライバシーポリシー",
    description: "AV Shorts のプライバシーポリシー。",
    url: "/privacy",
  },
};

export default function PrivacyPage() {
  return (
    <main style={styles.main}>
      <div style={styles.container}>
        <nav style={styles.nav}>
          <Link href="/" style={styles.backLink}>← トップへ戻る</Link>
        </nav>

        <h1 style={styles.h1}>プライバシーポリシー</h1>
        <p style={styles.updated}>最終更新日：2026年5月12日</p>

        <Section title="1. はじめに">
          <p>本サイト（以下「当サイト」）は、ユーザーのプライバシーを尊重し、個人情報の保護に努めます。本プライバシーポリシーは、当サイトにおける個人情報の取り扱いについて説明するものです。</p>
        </Section>

        <Section title="2. 収集する情報">
          <p>当サイトでは、以下の情報を収集することがあります。</p>
          <ul style={styles.ul}>
            <li>アクセスログ（IPアドレス、ブラウザ情報、アクセス日時、参照URL等）</li>
            <li>Cookieおよびこれに類する技術によって取得される情報</li>
            <li>年齢確認の同意状態（Cookieによる記録）</li>
          </ul>
        </Section>

        <Section title="3. 情報の利用目的">
          <p>収集した情報は、以下の目的で利用します。</p>
          <ul style={styles.ul}>
            <li>サービスの提供・運営・改善</li>
            <li>アクセス状況の分析</li>
            <li>不正アクセス・不正利用の防止</li>
            <li>法令上の義務の履行</li>
          </ul>
        </Section>

        <Section title="4. 第三者への提供">
          <p>当サイトは、以下の場合を除き、収集した個人情報を第三者に提供しません。</p>
          <ul style={styles.ul}>
            <li>ユーザーの同意がある場合</li>
            <li>法令に基づく場合</li>
            <li>人の生命・身体または財産の保護のために必要な場合</li>
          </ul>
        </Section>

        <Section title="5. Cookieについて">
          <p>当サイトでは、以下の目的でCookieを使用しています。</p>
          <ul style={styles.ul}>
            <li>年齢確認済み状態の保持</li>
            <li>アクセス解析ツール（Google Analytics 等）によるアクセス状況の把握</li>
          </ul>
          <p style={{marginTop: "12px"}}>ブラウザの設定によりCookieを無効にすることができますが、一部機能が利用できなくなる場合があります。</p>
        </Section>

        <Section title="6. アフィリエイトプログラムについて">
          <p>当サイトはFANZAアフィリエイトプログラムに参加しており、広告リンクを通じて商品・サービスを紹介することがあります。ユーザーが広告リンクを経由して購入した場合、当サイトに成果報酬が支払われることがあります。</p>
        </Section>

        <Section title="7. アクセス解析ツール">
          <p>当サイトは、Google Analytics等のアクセス解析ツールを使用することがあります。これらのツールはCookieを使用してデータを収集しますが、個人を特定する情報は含まれません。詳細は各ツールのプライバシーポリシーをご参照ください。</p>
        </Section>

        <Section title="8. 未成年者の利用について">
          <p>当サイトは18歳以上の方を対象としています。18歳未満の方の利用はお断りしており、年齢確認機能を設けています。</p>
        </Section>

        <Section title="9. プライバシーポリシーの変更">
          <p>本プライバシーポリシーは、法令の改正や当サイトのサービス変更に伴い、予告なく変更する場合があります。変更後のポリシーは本ページに掲載された時点から効力を生じます。</p>
        </Section>

        <Section title="10. お問い合わせ">
          <p>本プライバシーポリシーに関するお問い合わせは、下記の特定商取引法に基づく表記に記載の連絡先までお願いします。</p>
          <p style={{marginTop: "12px"}}>
            <Link href="/law" style={styles.link}>特定商取引法に基づく表記はこちら</Link>
          </p>
        </Section>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={styles.section}>
      <h2 style={styles.h2}>{title}</h2>
      <div style={styles.body}>{children}</div>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: "100dvh",
    paddingTop: "var(--header-h, 52px)",
    paddingBottom: "var(--bottom-nav-h, 56px)",
    background: "#0a0a0a",
    color: "#e0e0e0",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    boxSizing: "border-box",
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
    fontSize: "clamp(22px, 5vw, 32px)" as unknown as string,
    fontWeight: 700,
    marginBottom: "8px",
    color: "#fff",
  },
  updated: {
    fontSize: "13px",
    color: "#666",
    marginBottom: "40px",
  },
  section: {
    marginBottom: "32px",
    paddingBottom: "32px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
  },
  h2: {
    fontSize: "17px",
    fontWeight: 600,
    marginBottom: "12px",
    color: "#fff",
  },
  body: {
    fontSize: "14px",
    lineHeight: 1.8,
    color: "#bbb",
  },
  ul: {
    paddingLeft: "20px",
    marginTop: "8px",
    lineHeight: 2,
  },
  link: {
    color: "#e91e63",
    textDecoration: "underline",
  },
};
