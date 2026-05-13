import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AV Shorts",
  description: "縦型ショート動画でAV作品を探す",
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
      <head>
        {/* FANZAの動画CDNへの接続を事前確立してDNS+TCP+TLSのレイテンシを削減 */}
        <link rel="preconnect" href="https://cc3001.dmm.co.jp" />
        <link rel="preconnect" href="https://cc3001.dmm.co.jp" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://cc3001.dmm.co.jp" />
      </head>
      <body>
        {children}
        {modal}
      </body>
    </html>
  );
}
