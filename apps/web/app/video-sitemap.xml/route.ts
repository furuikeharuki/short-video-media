import { NextResponse } from "next/server";

import { SITE_NAME, SITE_URL } from "@/lib/config/seo";

export const revalidate = 3600;

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

type SitemapUrls = {
  movies: MovieSitemapEntry[];
};

const API_BASE_URL =
  process.env.API_BASE_URL ||
  process.env.INTERNAL_API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000";

const MAX_VIDEO_ENTRIES = 40_000;

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

async function fetchMovieSitemapEntries(): Promise<MovieSitemapEntry[]> {
  try {
    const params = new URLSearchParams({
      movie_limit: String(MAX_VIDEO_ENTRIES),
      actress_limit: "0",
      genre_limit: "0",
      include_video_meta: "true",
    });
    const res = await fetch(`${API_BASE_URL}/api/v1/sitemap/urls?${params}`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as SitemapUrls;
    return Array.isArray(data.movies) ? data.movies : [];
  } catch {
    return [];
  }
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

export async function GET(): Promise<Response> {
  const movies = await fetchMovieSitemapEntries();
  const entries = movies
    .map(renderVideoEntry)
    .filter((entry): entry is string => Boolean(entry));

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">',
    ...entries,
    "</urlset>",
  ].join("\n");

  return new NextResponse(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
