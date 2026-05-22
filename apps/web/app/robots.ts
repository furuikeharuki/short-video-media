import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/config/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // /age-gate は robots.txt では Disallow しない。
        // Disallow するとクローラがページ本文を取得できず、
        // meta robots="noindex" / X-Robots-Tag / canonical を読めないため
        // Google Search Console で "Duplicate without user-selected canonical"
        // (代替ページがあります - ユーザーにより選択された正規ページがありません)
        // として URL だけが残ってしまう。
        // /age-gate 側ではページ metadata と middleware の X-Robots-Tag で
        // noindex,nofollow を明示しているので、クロールを許可した方が
        // 確実に検索結果から除外される。
        disallow: [
          "/api/",
          "/mypage",
          "/mypage/",
          "/auth/",
          "/search",
          "/search/",
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
