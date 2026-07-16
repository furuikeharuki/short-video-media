import { SITE_URL } from "@/lib/config/seo";

/**
 * 通常の (非 video) sitemap を「sitemap index + 分割子 sitemap」で生成するための
 * ヘルパー群。
 *
 * 背景: 旧 app/sitemap.ts は movies(最大 40,000) + actresses(最大 9,000)
 * + genres(最大 2,000) + 静的ページを 1 ファイルにまとめており、合計が
 * Google の上限 50,000 URL を超えうる (かつ ~8MB の巨大ファイルになる)。
 * 種別ごとに子 sitemap を分割し、movies はさらに CHUNK 単位で分割する。
 * video-sitemap.xml (lib/sitemap/videoSitemap.ts) と同じ route handler 方式。
 */

type MovieUrlEntry = { slug: string; last_modified?: string | null };
type ActressUrlEntry = { name: string; last_modified?: string | null };
type GenreUrlEntry = { name: string; last_modified?: string | null };
type SitemapUrls = {
  movies: MovieUrlEntry[];
  actresses: ActressUrlEntry[];
  genres?: GenreUrlEntry[];
  movie_total?: number | null;
};

const API_BASE_URL = (
  process.env.API_BASE_URL ||
  process.env.INTERNAL_API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8000"
).replace(/\/+$/, "");

// API 側の上限に合わせる (apps/api sitemap.py: movies 40k / actresses 9k / genres 2k)。
export const MAX_MOVIE_ENTRIES = 40_000;
export const MOVIE_CHUNK_SIZE = 10_000; // 1 チャンク上限 (< 50,000)
export const ACTRESS_LIMIT = 9_000;
export const GENRE_LIMIT = 2_000;

const MAX_MOVIE_CHUNKS = Math.ceil(MAX_MOVIE_ENTRIES / MOVIE_CHUNK_SIZE);

export const CONTENT_SITEMAP_CACHE_CONTROL =
  "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toIsoLastmod(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function fetchSitemapUrls(params: URLSearchParams): Promise<SitemapUrls> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/sitemap/urls?${params}`, {
      cache: "no-store",
    });
    if (!res.ok) return { movies: [], actresses: [], genres: [] };
    return (await res.json()) as SitemapUrls;
  } catch {
    // ビルド時 / API 到達不可時は空で返し、静的ページだけで成立させる。
    return { movies: [], actresses: [], genres: [] };
  }
}

function clampMovieTotal(total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(Math.floor(total), MAX_MOVIE_ENTRIES);
}

export function getMovieChunkCount(total: number): number {
  const capped = clampMovieTotal(total);
  if (capped <= 0) return 0;
  return Math.ceil(capped / MOVIE_CHUNK_SIZE);
}

export async function fetchMovieTotal(): Promise<number> {
  const params = new URLSearchParams({
    movie_limit: "1",
    movie_offset: "0",
    actress_limit: "0",
    genre_limit: "0",
    include_movie_total: "true",
  });
  const data = await fetchSitemapUrls(params);
  if (typeof data.movie_total === "number") return clampMovieTotal(data.movie_total);
  // total が取れないときは安全側 (最大チャンク数) を返す。空チャンクは valid な XML。
  return MAX_MOVIE_ENTRIES;
}

export async function fetchMovieChunk(page: number): Promise<MovieUrlEntry[]> {
  const offset = (page - 1) * MOVIE_CHUNK_SIZE;
  if (offset < 0 || offset >= MAX_MOVIE_ENTRIES) return [];
  const params = new URLSearchParams({
    movie_limit: String(Math.min(MOVIE_CHUNK_SIZE, MAX_MOVIE_ENTRIES - offset)),
    movie_offset: String(offset),
    actress_limit: "0",
    genre_limit: "0",
  });
  const data = await fetchSitemapUrls(params);
  return Array.isArray(data.movies) ? data.movies : [];
}

export async function fetchActresses(): Promise<ActressUrlEntry[]> {
  const params = new URLSearchParams({
    movie_limit: "1",
    actress_limit: String(ACTRESS_LIMIT),
    genre_limit: "0",
  });
  const data = await fetchSitemapUrls(params);
  return Array.isArray(data.actresses) ? data.actresses : [];
}

export async function fetchGenres(): Promise<GenreUrlEntry[]> {
  const params = new URLSearchParams({
    movie_limit: "1",
    actress_limit: "0",
    genre_limit: String(GENRE_LIMIT),
  });
  const data = await fetchSitemapUrls(params);
  return Array.isArray(data.genres) ? data.genres : [];
}

export type ContentSitemapKey =
  | { kind: "pages" }
  | { kind: "genres" }
  | { kind: "actresses" }
  | { kind: "movies"; page: number };

export function parseContentSitemapPath(path: string[]): ContentSitemapKey | null {
  if (path.length === 1) {
    const seg = path[0]?.replace(/\.xml$/, "");
    if (seg === "pages") return { kind: "pages" };
    if (seg === "genres") return { kind: "genres" };
    if (seg === "actresses") return { kind: "actresses" };
    return null;
  }
  if (path.length === 2 && path[0] === "movies") {
    const match = /^(\d+)(?:\.xml)?$/.exec(path[1] ?? "");
    if (!match) return null;
    const page = Number(match[1]);
    if (!Number.isInteger(page) || page < 1 || page > MAX_MOVIE_CHUNKS) return null;
    return { kind: "movies", page };
  }
  return null;
}

type UrlEntry = {
  loc: string;
  lastmod?: string | null;
  changefreq?: string;
  priority?: number;
};

export function renderUrlset(entries: UrlEntry[]): string {
  const urls = entries.map((e) => {
    const parts = [
      "  <url>",
      `    <loc>${escapeXml(e.loc)}</loc>`,
      e.lastmod ? `    <lastmod>${escapeXml(e.lastmod)}</lastmod>` : null,
      e.changefreq ? `    <changefreq>${e.changefreq}</changefreq>` : null,
      e.priority != null ? `    <priority>${e.priority}</priority>` : null,
      "  </url>",
    ];
    return parts.filter(Boolean).join("\n");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
  ].join("\n");
}

export function renderSitemapIndex(
  children: { loc: string; lastmod?: string }[],
): string {
  const entries = children.map((c) =>
    [
      "  <sitemap>",
      `    <loc>${escapeXml(c.loc)}</loc>`,
      c.lastmod ? `    <lastmod>${escapeXml(c.lastmod)}</lastmod>` : null,
      "  </sitemap>",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    "</sitemapindex>",
  ].join("\n");
}

export function staticPageEntries(now = new Date()): UrlEntry[] {
  const iso = now.toISOString();
  const mk = (
    path: string,
    changefreq: string,
    priority: number,
  ): UrlEntry => ({
    loc: `${SITE_URL}${path}`,
    lastmod: iso,
    changefreq,
    priority,
  });
  return [
    mk("", "hourly", 1),
    mk("/list/popular", "daily", 0.8),
    mk("/list/new", "hourly", 0.8),
    mk("/list/recent", "hourly", 0.8),
    mk("/list/ranking_daily", "daily", 0.7),
    mk("/list/ranking_weekly", "daily", 0.7),
    mk("/list/ranking_monthly", "weekly", 0.7),
    mk("/law", "yearly", 0.2),
    mk("/privacy", "yearly", 0.2),
    mk("/contact", "yearly", 0.2),
  ];
}

export function movieUrlEntries(movies: MovieUrlEntry[]): UrlEntry[] {
  return movies.map((m) => ({
    loc: `${SITE_URL}/movies/${encodeURIComponent(m.slug)}`,
    lastmod: toIsoLastmod(m.last_modified),
    changefreq: "weekly",
    priority: 0.6,
  }));
}

export function actressUrlEntries(actresses: ActressUrlEntry[]): UrlEntry[] {
  return actresses.map((a) => ({
    loc: `${SITE_URL}/actresses/${encodeURIComponent(a.name)}`,
    lastmod: toIsoLastmod(a.last_modified),
    changefreq: "weekly",
    priority: 0.5,
  }));
}

export function genreUrlEntries(genres: GenreUrlEntry[]): UrlEntry[] {
  return genres.map((g) => ({
    loc: `${SITE_URL}/genres/${encodeURIComponent(g.name)}`,
    lastmod: toIsoLastmod(g.last_modified),
    changefreq: "daily",
    priority: 0.6,
  }));
}
