import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

type RouteContext = { params: Promise<{ slug: string }> };

type ResolveMp4Response = {
  mp4_url?: string | null;
  high_mp4_url?: string | null;
  low_mp4_url?: string | null;
};

const API_BASE_URL = (
  process.env.INTERNAL_API_BASE_URL ??
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  ""
).replace(/\/+$/, "");

async function redirectToSampleVideo(context: RouteContext): Promise<Response> {
  if (!API_BASE_URL) {
    return NextResponse.json({ error: "API not configured" }, { status: 503 });
  }

  const { slug } = await context.params;
  const targetUrl = `${API_BASE_URL}/api/v1/movies/${encodeURIComponent(
    slug,
  )}/resolve-mp4`;

  let apiRes: Response;
  try {
    apiRes = await fetch(targetUrl, { cache: "no-store" });
  } catch (e) {
    console.error("[sample-video] upstream fetch failed", { targetUrl, error: e });
    return NextResponse.json({ error: "Bad Gateway" }, { status: 502 });
  }

  if (!apiRes.ok) {
    return NextResponse.json(
      { error: "Sample video not available" },
      { status: apiRes.status },
    );
  }

  const data = (await apiRes.json().catch(() => null)) as ResolveMp4Response | null;
  const mp4Url = data?.high_mp4_url || data?.mp4_url || data?.low_mp4_url;
  if (!mp4Url) {
    return NextResponse.json({ error: "Sample video not available" }, { status: 404 });
  }

  const response = NextResponse.redirect(mp4Url, 302);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  return redirectToSampleVideo(context);
}

export async function HEAD(_request: NextRequest, context: RouteContext) {
  return redirectToSampleVideo(context);
}
