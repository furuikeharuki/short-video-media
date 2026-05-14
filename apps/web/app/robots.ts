import type { MetadataRoute } from "next";

const SITE_URL = "https://av-shorts.com";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/age-gate/"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
