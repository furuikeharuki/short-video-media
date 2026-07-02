import { NextRequest, NextResponse } from "next/server";

import {
  fetchMovieSitemapEntries,
  parseVideoSitemapPage,
  renderVideoSitemap,
  VIDEO_SITEMAP_CACHE_CONTROL,
} from "@/lib/sitemap/videoSitemap";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(_request: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const page = parseVideoSitemapPage(path);
  if (page === null) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const movies = await fetchMovieSitemapEntries(page);
  const xml = renderVideoSitemap(movies);

  return new NextResponse(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": VIDEO_SITEMAP_CACHE_CONTROL,
    },
  });
}
