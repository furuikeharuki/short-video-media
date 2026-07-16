import type { Metadata, Viewport } from "next";
import Script from "next/script";
import Header from "@/components/Header";
import BottomNav from "@/components/BottomNav";
import BottomNavFreezeBootstrap from "@/components/BottomNavFreezeBootstrap";
import NavigationLoadingOverlay from "@/components/NavigationLoadingOverlay";
import SessionProvider from "@/components/SessionProvider";
import SavedFilterEnforcer from "@/components/SavedFilterEnforcer";
import FullpageInterstitial from "@/components/ads/FullpageInterstitial";
import AgeGateOverlay from "@/components/age-gate/AgeGateOverlay";
import BuildIdLogger from "@/components/BuildIdLogger";
import HydrationDebugEarlyScript from "@/components/HydrationDebugEarlyScript";
import {
  SITE_NAME,
  SITE_URL,
  SITE_DESCRIPTION,
  HOME_DESCRIPTION,
  SITE_KEYWORDS,
  SITE_LOCALE,
} from "@/lib/config/seo";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_NAME,
    template: "%s",
  },
  description: SITE_DESCRIPTION,
  keywords: SITE_KEYWORDS,
  authors: [{ name: SITE_NAME }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  applicationName: SITE_NAME,
  category: "entertainment",
  verification: {
    google: "yE_TjT7FgGV-2DYARJhuv3UOAm8-2QUJfSnZoIlVjiA",
    other: {
      "6a97888e-site-verification": "cc3e298a0904fce9fab07e30b99e9f23",
    },
  },
  openGraph: {
    type: "website",
    locale: SITE_LOCALE,
    url: SITE_URL,
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_NAME,
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
  const BUILD_ID =
    process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ||
    "dev";

  const websiteJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: SITE_URL,
    description: HOME_DESCRIPTION,
    inLanguage: "ja-JP",
    potentialAction: {
      "@type": "SearchAction",
      target: `${SITE_URL}/search?q={search_term_string}`,
      "query-input": "required name=search_term_string",
    },
  };

  const orgJsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
  };

  return (
    <html lang="ja">
      <head>
        <meta name="x-build-id" content={BUILD_ID} />
        {/*
         * React #418 (hydration mismatch) を「listener が走り始める前」に
         * 取り逃がさないための同期 <script>。useEffect 版は hydration 完了後に
         * しか listener を貼れず本番で空振りしたため、<head> 内 inline に移動。
         * ?vt=1 か NEXT_PUBLIC_HYDRATION_DEBUG=1 のときだけ実装が走る。
         * 詳細は components/HydrationDebugEarlyScript.tsx。
         */}
        <HydrationDebugEarlyScript />
        {/*
         * BottomNav の Chrome 限定フルページ遷移チラつき対策。
         * 同期スクリプトとして <head> に置き、ハイドレーション以前 / first paint
         * 直前に sessionStorage を読んで <html> へ data-nav-freeze-active-href
         * 属性を付ける。詳細は components/BottomNavFreezeBootstrap.tsx。
         */}
        <BottomNavFreezeBootstrap />
        <link rel="preconnect" href="https://cc3001.dmm.co.jp" />
        <link rel="preconnect" href="https://cc3001.dmm.co.jp" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://cc3001.dmm.co.jp" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd) }}
        />
      </head>
      <body>
        {/* GA (gtag) は afterInteractive で読み込み、初期描画 (LCP/TBT) を阻害しない。
            同期/head 直挿しだと計測タグが初期ロードの帯域・メインスレッドを奪うため。 */}
        {GA_ID && (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
              strategy="afterInteractive"
            />
            <Script id="ga-init" strategy="afterInteractive">
              {`
                window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}
                gtag('js', new Date());
                gtag('config', '${GA_ID}');
              `}
            </Script>
          </>
        )}
        <SessionProvider>
          {/* /feed と /search 表示時に保存済みフィルターを URL に自動注入し、
              children に対して enforce ステータス (pending/ready) を Context で共有する。
              FeedClient / SearchInfiniteGrid はこの値が ready になるまで
              スピナーを出して "フィルター違反作品が一瞬見える" フラッシュを防ぐ。 */}
          <SavedFilterEnforcer>
            <BuildIdLogger buildId={BUILD_ID} />
            <Header />
            {children}
            {modal}
            <AgeGateOverlay />
            <BottomNav />
            {/* /feed から / や /mypage へフルページ遷移する瞬間に、ヘッダーと
                ボトムナビの間だけを黒+スピナーで覆って「タップが効いた」感を即返す。
                通常は非表示で、BottomNav / HamburgerMenu から `nav-loading-show` を
                受け取ったときだけ表示する。 */}
            <NavigationLoadingOverlay />
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
