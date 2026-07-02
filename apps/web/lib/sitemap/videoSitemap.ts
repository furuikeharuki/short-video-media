import { SITE_NAME, SITE_URL } from "@/lib/config/seo";

export type MovieSitemapEntry = {
  slug: string;
  last_modified?: string | null;
  title?: string | null;
  description?: string | null;
  thumbnail_url?: string | null;
  sample_embed_url?: string | null;
  content_id?: string | null;
  publication_date?: string | null;
};

type SitemapUrls = {
  movies: MovieSitemapEntry[];
  movie_total?: number | null;
};

const API_BASE_URL = (
  process.env.API_BASE_URL ||
  process.env.INTERNAL_API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000"
).replace(/\/+$/, "");

export const MAX_VIDEO_SITEMAP_ENTRIES = 40_000;
export const VIDEO_SITEMAP_CHUNK_SIZE = 3_000;
export const VIDEO_SITEMAP_CACHE_CONTROL =
  "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400";

const MAX_VIDEO_SITEMAP_CHUNKS = Math.ceil(
  MAX_VIDEO_SITEMAP_ENTRIES / VIDEO_SITEMAP_CHUNK_SIZE,
);

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeHttps(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http://")) return `https://${url.slice("http://".length)}`;
  return url;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function clampVideoSitemapTotal(total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(Math.floor(total), MAX_VIDEO_SITEMAP_ENTRIES);
}

export function getVideoSitemapChunkCount(total: number): number {
  const cappedTotal = clampVideoSitemapTotal(total);
  if (cappedTotal <= 0) return 0;
  return Math.ceil(cappedTotal / VIDEO_SITEMAP_CHUNK_SIZE);
}

export function parseVideoSitemapPage(path: string[]): number | null {
  if (path.length !== 1) return null;
  const match = /^(\d+)(?:\.xml)?$/.exec(path[0] ?? "");
  if (!match) return null;
  const page = Number(match[1]);
  if (!Number.isInteger(page) || page < 1 || page > MAX_VIDEO_SITEMAP_CHUNKS) {
    return null;
  }
  return page;
}

export async function fetchMovieSitemapTotal(): Promise<number> {
  try {
    const params = new URLSearchParams({
      movie_limit: "1",
      movie_offset: "0",
      actress_limit: "0",
      genre_limit: "0",
      include_movie_total: "true",
    });
    const res = await fetch(`${API_BASE_URL}/api/v1/sitemap/urls?${params}`, {
      cache: "no-store",
    });
    if (!res.ok) return MAX_VIDEO_SITEMAP_ENTRIES;
    const data = (await res.json()) as SitemapUrls;
    if (typeof data.movie_total === "number") {
      return clampVideoSitemapTotal(data.movie_total);
    }
    return MAX_VIDEO_SITEMAP_ENTRIES;
  } catch {
    return MAX_VIDEO_SITEMAP_ENTRIES;
  }
}

export async function fetchMovieSitemapEntries(page: number): Promise<MovieSitemapEntry[]> {
  const offset = (page - 1) * VIDEO_SITEMAP_CHUNK_SIZE;
  if (offset < 0 || offset >= MAX_VIDEO_SITEMAP_ENTRIES) return [];

  try {
    const params = new URLSearchParams({
      movie_limit: String(
        Math.min(VIDEO_SITEMAP_CHUNK_SIZE, MAX_VIDEO_SITEMAP_ENTRIES - offset),
      ),
      movie_offset: String(offset),
      actress_limit: "0",
      genre_limit: "0",
      include_video_meta: "true",
    });
    const res = await fetch(`${API_BASE_URL}/api/v1/sitemap/urls?${params}`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = (await res.json()) as SitemapUrls;
    return Array.isArray(data.movies) ? data.movies : [];
  } catch {
    return [];
  }
}

export function renderVideoSitemapIndex(chunkCount: number, lastModified = new Date()): string {
  const entries = Array.from({ length: chunkCount }, (_, index) => {
    const page = index + 1;
    return [
      "  <sitemap>",
      `    <loc>${escapeXml(`${SITE_URL}/video-sitemap/${page}.xml`)}</loc>`,
      `    <lastmod>${escapeXml(lastModified.toISOString())}</lastmod>`,
      "  </sitemap>",
    ].join("\n");
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    "</sitemapindex>",
  ].join("\n");
}

function renderVideoEntry(movie: MovieSitemapEntry): string | null {
  if (!movie.slug || !movie.content_id) return null;

  const thumbnailUrl = normalizeHttps(movie.thumbnail_url);
  if (!thumbnailUrl) return null;

  const title = truncate(movie.title?.trim() || `${SITE_NAME} サンプル動画`, 100);
  const description = truncate(
    movie.description?.trim() || `${title} のショートサンプル動画です。`,
    2048,
  );
  const pageUrl = `${SITE_URL}/movies/${encodeURIComponent(movie.slug)}`;
  const contentUrl = `${SITE_URL}/videos/${encodeURIComponent(movie.slug)}/sample.mp4`;
  const playerUrl = normalizeHttps(movie.sample_embed_url);

  return [
    "  <url>",
    `    <loc>${escapeXml(pageUrl)}</loc>`,
    "    <video:video>",
    `      <video:thumbnail_loc>${escapeXml(thumbnailUrl)}</video:thumbnail_loc>`,
    `      <video:title>${escapeXml(title)}</video:title>`,
    `      <video:description>${escapeXml(description)}</video:description>`,
    `      <video:content_loc>${escapeXml(contentUrl)}</video:content_loc>`,
    playerUrl
      ? `      <video:player_loc allow_embed="yes">${escapeXml(playerUrl)}</video:player_loc>`
      : null,
    movie.publication_date
      ? `      <video:publication_date>${escapeXml(movie.publication_date)}</video:publication_date>`
      : null,
    "      <video:family_friendly>no</video:family_friendly>",
    "      <video:requires_subscription>no</video:requires_subscription>",
    "    </video:video>",
    "  </url>",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderVideoSitemap(movies: MovieSitemapEntry[]): string {
  const entries = movies
    .map(renderVideoEntry)
    .filter((entry): entry is string => Boolean(entry));

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">',
    ...entries,
    "</urlset>",
  ].join("\n");
}
