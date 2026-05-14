import type { Metadata } from "next";
import Header from "@/components/Header";
import AffiliateNotice from "@/components/AffiliateNotice";
import "./globals.css";

const SITE_NAME = "AV Shorts";
const SITE_URL = "https://av-shorts.com";
const SITE_DESCRIPTION = "FANZAのAV作品をショート動画で試し見。気に入ったらそのまま購入できるアダルト動画メディア。";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} | AVショート動画メディア`,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  keywords: ["AV", "ショート動画", "FANZA", "アダルト動画", "サンプル動画", "アフィリエイト"],
  authors: [{ name: SITE_NAME }],
  creator: SITE_NAME,
  openGraph: {
    type: "website",
    locale: "ja_JP",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: `${SITE_NAME} | AVショート動画メディア`,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} | AVショート動画メディア`,
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  alternates: {
    canonical: SITE_URL,
  },
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
