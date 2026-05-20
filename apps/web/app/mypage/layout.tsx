import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "マイページ",
  description: "ブックマークした作品と視聴履歴を確認できます。",
  robots: { index: false, follow: false },
};

export default function MyPageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
