import type { Metadata } from "next";
import Header from "@/components/Header";
import AffiliateNotice from "@/components/AffiliateNotice";
import "./globals.css";

export const metadata: Metadata = {
  title: "AV Shorts",
  description: "AVのショート動画メディア",
};

export default function RootLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>
        <Header />
        <AffiliateNotice />
        {children}
        {modal}
      </body>
    </html>
  );
}
