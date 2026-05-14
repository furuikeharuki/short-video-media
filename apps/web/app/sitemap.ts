import type { MetadataRoute } from "next";

const SITE_URL = "https://av-shorts.com";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      lastModified: new Date(),
      changeFrequency: "hourly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/movies`,
      lastModified: new Date(),
      changeFrequency: "hourly",
      priority: 0.8,
    },
  ];
}
