import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/config/seo";

type MovieSitemapEntry = {
  slug: string;
  last_modified?: string | null;
  title?: string | null;
  description?: string | null;
  thumbnail_url?: string | null;
  sample_embed_url?: string | null;
  content_id?: string | null;
  publication_date?: string | null;
};
type ActressSitemapEntry = { name: string; last_modified?: string | null };
type GenreSitemapEntry = { name: string; last_modified?: string | null };
type SitemapUrls = {
  movies: MovieSitemapEntry[];
  actresses: ActressSitemapEntry[];
  genres?: GenreSitemapEntry[];
};

const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.INTERNAL_API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000";

// /api/v1/sitemap/urls は 4 万件規模になると Next Data Cache の 2MB 上限を超える。
// Vercel build 時の data-cache warning を避けるため、sitemap.xml は request 時に生成し、
// 巨大 JSON を Next の fetch cache へ保存しない。
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

function parseLastModified(s: string | null | undefined, fallback: Date): Date {
  if (!s) return fallback;
  const d = new Date(s);
  return isNaN(d.getTime()) ? fallback : d;
}

async function fetchSitemapUrls(): Promise<SitemapUrls> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/sitemap/urls`, {
      cache: "no-store",
    });
    if (!res.ok) {
      return { movies: [], actresses: [], genres: [] };
    }
    return (await res.json()) as SitemapUrls;
  } catch {
    // ビルド時に API に到達できない場合 (CI など) は静的 URL だけで生成する。
    return { movies: [], actresses: [], genres: [] };
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const { movies, actresses, genres = [] } = await fetchSitemapUrls();

  // 静的ページ。/age-gate は middleware と metadata で noindex を明示しているため
  // sitemap に載せない。/search?genre=... 等のカテゴリページも `robots: { index: false }`
  // が付いており検索結果ページとして意図的に noindex なので、sitemap には含めない。
  // /mypage, /auth/*, /api/* は robots.ts で Disallow 済み。
  // /feed は force-dynamic な client 専用ページで SSR HTML が実質空のため
  // metadata で noindex を付与した。sitemap からも除外して整合させる。
  const staticEntries: MetadataRoute.Sitemap = [
    {
      url: SITE_URL,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 1,
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

  // ジャンル集約ページ (/genres/[genre])。/search?genre=... は noindex のままで、
  // index 対象はこちらの集約ページに寄せる。
  const genreEntries: MetadataRoute.Sitemap = genres.map((g) => ({
    url: `${SITE_URL}/genres/${encodeURIComponent(g.name)}`,
    lastModified: parseLastModified(g.last_modified, now),
    changeFrequency: "daily",
    priority: 0.6,
  }));

  return [
    ...staticEntries,
    ...genreEntries,
    ...actressEntries,
    ...movieEntries,
  ];
}
