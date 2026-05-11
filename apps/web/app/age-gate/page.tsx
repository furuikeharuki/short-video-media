import { cookies } from "next/headers";
import { redirect } from "next/navigation";

type AgeGatePageProps = {
  searchParams: Promise<{
    next?: string;
  }>;
};

async function verifyAge(nextPath: string) {
  "use server";

  const cookieStore = await cookies();
  cookieStore.set("age_verified", "true", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });

  redirect(nextPath || "/");
}

export default async function AgeGatePage({ searchParams }: AgeGatePageProps) {
  const params = await searchParams;
  const nextPath = params.next || "/";

  return (
    <main style={{ padding: "24px", maxWidth: "720px", margin: "0 auto" }}>
      <h1>年齢確認</h1>
      <p>このサイトは成人向けコンテンツへの導線を含みます。</p>
      <p>18歳未満の方は利用できません。</p>

      <form action={async () => {
        "use server";
        await verifyAge(nextPath);
      }}>
        <button
          type="submit"
          style={{
            marginTop: "16px",
            padding: "10px 16px",
            border: "1px solid #ddd",
            borderRadius: "8px",
            background: "#fff",
            cursor: "pointer",
          }}
        >
          18歳以上です
        </button>
      </form>

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