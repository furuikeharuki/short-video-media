import { NextRequest, NextResponse } from "next/server";

import {
  CONTENT_SITEMAP_CACHE_CONTROL,
  actressUrlEntries,
  fetchActresses,
  fetchGenres,
  fetchMovieChunk,
  genreUrlEntries,
  movieUrlEntries,
  parseContentSitemapPath,
  renderUrlset,
  staticPageEntries,
} from "@/lib/sitemap/contentSitemap";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(
  _request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const { path } = await context.params;
  const key = parseContentSitemapPath(path);
  if (key === null) {
    return new NextResponse("Not Found", { status: 404 });
  }

  let xml: string;
  switch (key.kind) {
    case "pages":
      xml = renderUrlset(staticPageEntries());
      break;
    case "genres":
      xml = renderUrlset(genreUrlEntries(await fetchGenres()));
      break;
    case "actresses":
      xml = renderUrlset(actressUrlEntries(await fetchActresses()));
      break;
    case "movies":
      xml = renderUrlset(movieUrlEntries(await fetchMovieChunk(key.page)));
      break;
  }

  return new NextResponse(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": CONTENT_SITEMAP_CACHE_CONTROL,
    },
  });
}
