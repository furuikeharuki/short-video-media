import type { Metadata, Viewport } from "next";
import Header from "@/components/Header";
import BottomNav from "@/components/BottomNav";
import SessionProvider from "@/components/SessionProvider";
import SavedFilterEnforcer from "@/components/SavedFilterEnforcer";
import FullpageInterstitial from "@/components/ads/FullpageInterstitial";
import "./globals.css";

const SITE_NAME = "AV Shorts";
const SITE_URL = "https://av-shorts.com";
const SITE_DESCRIPTION = "FANZAのAV作品をショート動画で試し見。気に入ったらそのまま購入できるアダルト動画メディア。";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

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
  verification: {
    google: "yE_TjT7FgGV-2DYARJhuv3UOAm8-2QUJfSnZoIlVjiA",
    other: {
      "6a97888e-site-verification": "cc3e298a0904fce9fab07e30b99e9f23",
    },
  },
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
        <link rel="preconnect" href="https://cc3001.dmm.co.jp" />
        <link rel="preconnect" href="https://cc3001.dmm.co.jp" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://cc3001.dmm.co.jp" />
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
        <SessionProvider>
          {/* /feed と /search 表示時に保存済みフィルターを URL に自動注入し、
              children に対して enforce ステータス (pending/ready) を Context で共有する。
              FeedClient / SearchInfiniteGrid はこの値が ready になるまで
              スピナーを出して "フィルター違反作品が一瞬見える" フラッシュを防ぐ。 */}
          <SavedFilterEnforcer>
            <Header />
            {children}
            {modal}
            <BottomNav />
            {/* Mobile Fullpage Interstitial (ExoClick). NEXT_PUBLIC_AD_FULLPAGE_INTERSTITIAL_ENABLED
                かつ全体スイッチが ON のときだけ動く。デフォルト OFF。
                セッション中 1 回だけ provider に serve を依頼する。 */}
            <FullpageInterstitial />
          </SavedFilterEnforcer>
        </SessionProvider>
      </body>
    </html>
  );
}
