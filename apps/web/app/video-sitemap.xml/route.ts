import { NextResponse } from "next/server";

import {
  fetchMovieSitemapTotal,
  getVideoSitemapChunkCount,
  renderVideoSitemapIndex,
  VIDEO_SITEMAP_CACHE_CONTROL,
} from "@/lib/sitemap/videoSitemap";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export async function GET(): Promise<Response> {
  const total = await fetchMovieSitemapTotal();
  const xml = renderVideoSitemapIndex(getVideoSitemapChunkCount(total));

  return new NextResponse(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": VIDEO_SITEMAP_CACHE_CONTROL,
    },
  });
}
