import Link from "next/link";

export default function AgeGatePage() {
  return (
    <main style={{ padding: "24px", maxWidth: "720px", margin: "0 auto" }}>
      <h1>年齢確認</h1>
      <p>このサイトは成人向けコンテンツへの導線を含みます。</p>
      <p>18歳未満の方は利用できません。</p>

      <div style={{ display: "flex", gap: "12px", marginTop: "16px" }}>
        <Link href="/">18歳以上です</Link>
        <a href="https://www.google.com" target="_blank" rel="noopener noreferrer">
          18歳未満です
        </a>
      </div>
    </main>
  );
}