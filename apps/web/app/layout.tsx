import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AV Shorts",
  description: "縦型ショート動画でAV作品を探す",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        {/* FANZAの動画CDNへの接続を事前確立してDNS+TCP+TLSのレイテンシを削減 */}
        <link rel="preconnect" href="https://cc3001.dmm.co.jp" />
        <link rel="preconnect" href="https://cc3001.dmm.co.jp" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://cc3001.dmm.co.jp" />
        <link rel="preconnect" href="https://d2b5w5e5s4v5v5.cloudfront.net" />
        <link rel="dns-prefetch" href="https://d2b5w5e5s4v5v5.cloudfront.net" />
      </head>
      <body>{children}</body>
    </html>
  );
}
