import { NextResponse } from "next/server";

import { SITE_URL } from "@/lib/config/seo";
import {
  CONTENT_SITEMAP_CACHE_CONTROL,
  fetchMovieTotal,
  getMovieChunkCount,
  renderSitemapIndex,
} from "@/lib/sitemap/contentSitemap";

// 巨大 JSON を Next の fetch cache に載せないよう request 時生成に固定する。
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export async function GET(): Promise<Response> {
  const lastmod = new Date().toISOString();
  const movieChunks = getMovieChunkCount(await fetchMovieTotal());

  const children: { loc: string; lastmod?: string }[] = [
    { loc: `${SITE_URL}/sitemap/pages.xml`, lastmod },
    { loc: `${SITE_URL}/sitemap/genres.xml`, lastmod },
    { loc: `${SITE_URL}/sitemap/actresses.xml`, lastmod },
    ...Array.from({ length: movieChunks }, (_, i) => ({
      loc: `${SITE_URL}/sitemap/movies/${i + 1}.xml`,
      lastmod,
    })),
  ];

  return new NextResponse(renderSitemapIndex(children), {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": CONTENT_SITEMAP_CACHE_CONTROL,
    },
  });
}
