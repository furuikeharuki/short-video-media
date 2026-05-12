import type { Metadata } from "next";
import { getPopularTags } from "@/lib/api/tags";
import Header from "@/components/Header";
import "./globals.css";

export const metadata: Metadata = {
  title: "ShortVid",
  description: "ショート動画メディア",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // レイアウトはServer Componentなので、ここでサーバーサイドフェッチ。
  // 1時間キャッシュされるためAPI負荷は最小限。
  const popularTags = await getPopularTags(20);

  return (
    <html lang="ja">
      <body>
        <Header popularTags={popularTags} />
        {children}
      </body>
    </html>
  );
}
