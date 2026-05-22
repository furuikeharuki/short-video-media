import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/config/seo";

type MovieSitemapEntry = { slug: string; last_modified: string | null };
type ActressSitemapEntry = { name: string; last_modified: string | null };
type SitemapUrls = {
  movies: MovieSitemapEntry[];
  actresses: ActressSitemapEntry[];
};

const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000";

// sitemap.xml は Next.js 側で 1 時間キャッシュする。API 側でも軽い処理だが
// クローラがリトライしてきても DB に負荷をかけないようにしておく。
export const revalidate = 3600;

function parseLastModified(s: string | null, fallback: Date): Date {
  if (!s) return fallback;
  const d = new Date(s);
  return isNaN(d.getTime()) ? fallback : d;
}

async function fetchSitemapUrls(): Promise<SitemapUrls> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/sitemap/urls`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) {
      return { movies: [], actresses: [] };
    }
    return (await res.json()) as SitemapUrls;
  } catch {
    // ビルド時に API に到達できない場合 (CI など) は静的 URL だけで生成する。
    return { movies: [], actresses: [] };
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const { movies, actresses } = await fetchSitemapUrls();

  // 静的ページ。/age-gate は middleware と metadata で noindex を明示しているため
  // sitemap に載せない。/search?genre=... 等のカテゴリページも `robots: { index: false }`
  // が付いており検索結果ページとして意図的に noindex なので、sitemap には含めない。
  // /mypage, /auth/*, /api/* は robots.ts で Disallow 済み。
  const staticEntries: MetadataRoute.Sitemap = [
    {
      url: SITE_URL,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/feed`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.9,
    },
    {
      url: `${SITE_URL}/list/popular`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/list/new`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/list/recent`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/list/ranking_daily`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.7,
    },
    {
      url: `${SITE_URL}/list/ranking_weekly`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.7,
    },
    {
      url: `${SITE_URL}/list/ranking_monthly`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${SITE_URL}/law`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.2,
    },
    {
      url: `${SITE_URL}/privacy`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.2,
    },
    {
      url: `${SITE_URL}/contact`,
      lastModified: now,
      changeFrequency: "yearly",
      priority: 0.2,
    },
  ];

  const movieEntries: MetadataRoute.Sitemap = movies.map((m) => ({
    url: `${SITE_URL}/movies/${m.slug}`,
    lastModified: parseLastModified(m.last_modified, now),
    changeFrequency: "weekly",
    priority: 0.6,
  }));

  const actressEntries: MetadataRoute.Sitemap = actresses.map((a) => ({
    url: `${SITE_URL}/actresses/${encodeURIComponent(a.name)}`,
    lastModified: parseLastModified(a.last_modified, now),
    changeFrequency: "weekly",
    priority: 0.5,
  }));

  return [...staticEntries, ...actressEntries, ...movieEntries];
}
