import Link from "next/link";

export const metadata = {
  title: "お問い合わせ | AVShorts",
};

export default function ContactPage() {
  return (
    <main style={styles.main}>
      <div style={styles.inner}>
        <h1 style={styles.title}>お問い合わせ</h1>
        <p style={styles.desc}>
          サイトに関するお問い合わせ、リンク切れ・不具合の報告などは以下のメールアドレスまでお送りください。
        </p>

        <div style={styles.card}>
          <p style={styles.cardLabel}>メールアドレス</p>
          <a href="mailto:avshorts0512@gmail.com" style={styles.email}>
            avshorts0512@gmail.com
          </a>
        </div>

        <div style={styles.noticeBox}>
          <p style={styles.noticeTitle}>ご連絡前にお読みください</p>
          <ul style={styles.noticeList}>
            <li>返信は数日以内を目安に行っておりますが、内容によっては返信できない場合があります。</li>
            <li>商品の購入・返品に関するお問い合わせはFANZA公式サポートへお願いします。</li>
            <li>18歳未満の方からのお問い合わせはお断りしております。</li>
          </ul>
        </div>

        <Link href="/" style={styles.back}>← トップに戻る</Link>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: "100dvh",
    paddingTop: "calc(52px + 32px + 28px)", // header + affiliateNotice + 余白
    background: "#0a0a0a",
    color: "#fff",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  inner: {
    maxWidth: "560px",
    margin: "0 auto",
    padding: "0 20px 60px",
  },
  title: {
    fontSize: "24px",
    fontWeight: 700,
    marginBottom: "16px",
  },
  desc: {
    fontSize: "14px",
    color: "rgba(255,255,255,0.6)",
    lineHeight: 1.7,
    marginBottom: "28px",
  },
  card: {
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: "12px",
    padding: "20px 24px",
    marginBottom: "24px",
  },
  cardLabel: {
    fontSize: "11px",
    color: "rgba(255,255,255,0.4)",
    marginBottom: "8px",
    letterSpacing: "0.05em",
    textTransform: "uppercase" as const,
  },
  email: {
    color: "#e91e63",
    fontSize: "15px",
    fontWeight: 600,
    textDecoration: "none",
    wordBreak: "break-all" as const,
  },
  noticeBox: {
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: "10px",
    padding: "16px 20px",
    marginBottom: "32px",
  },
  noticeTitle: {
    fontSize: "12px",
    fontWeight: 700,
    color: "rgba(255,255,255,0.5)",
    marginBottom: "10px",
    letterSpacing: "0.04em",
  },
  noticeList: {
    paddingLeft: "18px",
    margin: 0,
    fontSize: "13px",
    color: "rgba(255,255,255,0.45)",
    lineHeight: 1.8,
  },
  back: {
    display: "inline-block",
    color: "rgba(255,255,255,0.5)",
    fontSize: "13px",
    textDecoration: "none",
  },
};
