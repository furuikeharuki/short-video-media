import Link from "next/link";

export default function NotFoundPage() {
  return (
    <main style={{ padding: "24px" }}>
      <h1>404 - Page Not Found</h1>
      <p>お探しのページは見つかりませんでした。</p>
      <p>
        <Link href="/">トップに戻る</Link>
      </p>
    </main>
  );
}