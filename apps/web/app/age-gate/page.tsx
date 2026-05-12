import AgeGateForm from "@/components/analytics/age-gate-form";

type AgeGatePageProps = {
  searchParams: Promise<{
    next?: string;
  }>;
};

export default async function AgeGatePage({ searchParams }: AgeGatePageProps) {
  const params = await searchParams;
  const nextPath = params.next || "/";

  return (
    <main style={{ padding: "24px", maxWidth: "720px", margin: "0 auto" }}>
      <h1>年齢確認</h1>
      <p>このサイトは成人向けコンテンツへの導線を含みます。</p>
      <p>18歳未満の方は利用できません。</p>

      <AgeGateForm nextPath={nextPath} />

      <p style={{ marginTop: "16px" }}>
        <a
          href="https://www.google.com"
          target="_blank"
          rel="noopener noreferrer"
        >
          18歳未満です
        </a>
      </p>
    </main>
  );
}