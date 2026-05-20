import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/config/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/age-gate",
          "/age-gate/",
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
