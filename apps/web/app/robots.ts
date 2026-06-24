import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/config/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // • /age-gate — Disallow しない。クローラが noindex メタを読めるようにする。
        // • /search  — 同様に Disallow しない。
        //   /search も metadata で robots="noindex,follow" を明示しており、
        //   Google はクロールして noindex を読んで検索結果から除外する。
        //   Disallow にすると noindex を読めず、かつジャンルページからの内部リンクの
        //   クロール連鎖が断ち切れ、PageRank の流れも失われる。
        disallow: [
          "/api/",
          "/mypage",
          "/mypage/",
          "/auth/",
        ],
      },
    ],
    sitemap: [
      `${SITE_URL}/sitemap.xml`,
      `${SITE_URL}/video-sitemap.xml`,
    ],
    host: SITE_URL,
  };
}
