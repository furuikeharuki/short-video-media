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
  const GA_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

  return (
    <html lang="ja">
      <head>
        {/* FANZAの動画CDNへの接続を事前確立してDNS+TCP+TLSのレイテンシを削減 */}
        <link rel="preconnect" href="https://cc3001.dmm.co.jp" />
        <link rel="preconnect" href="https://cc3001.dmm.co.jp" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://cc3001.dmm.co.jp" />
        {/* Google Analytics GA4 */}
        {GA_ID && (
          <>
            <script async src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} />
            <script
              dangerouslySetInnerHTML={{
                __html: `
                  window.dataLayer = window.dataLayer || [];
                  function gtag(){dataLayer.push(arguments);}
                  gtag('js', new Date());
                  gtag('config', '${GA_ID}');
                `,
              }}
            />
          </>
        )}
      </head>
      <body>
        <Header />
        <AffiliateNotice />
        {children}
        {modal}
      </body>
    </html>
  );
}
