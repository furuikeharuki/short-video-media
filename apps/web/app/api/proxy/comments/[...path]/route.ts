/**
 * /api/proxy/comments/* → FastAPI への薄いプロキシ。
 *
 * 認証必須エンドポイント (POST /api/v1/movies/{slug}/comments, DELETE /api/v1/comments/{id})
 * を呼ぶときに、Auth.js セッションから apiToken を取り出して
 * Authorization: Bearer に付与する。/me proxy と同じ仕組み。
 *
 * URL マッピング:
 *   POST   /api/proxy/comments/{slug}        → POST   /api/v1/movies/{slug}/comments
 *   DELETE /api/proxy/comments/by-id/{id}    → DELETE /api/v1/comments/{id}
 *
 * GET (公開) は NEXT_PUBLIC_API_BASE_URL を直接叩くため、ここではサポートしない。
 */

import { NextRequest, NextResponse } from "next/server";
import type { Session } from "next-auth";

import { auth } from "@/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const API_BASE_URL = (
  process.env.INTERNAL_API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  ""
).replace(/\/+$/, "");

type RouteContext = { params: Promise<{ path: string[] }> };

function buildTargetPath(segments: string[]): string | null {
  // DELETE 用: /api/proxy/comments/by-id/{id} → /api/v1/comments/{id}
  if (segments.length === 2 && segments[0] === "by-id") {
    const id = segments[1];
    if (!id) return null;
    return `/api/v1/comments/${encodeURIComponent(id)}`;
  }
  // POST 用: /api/proxy/comments/{slug} → /api/v1/movies/{slug}/comments
  if (segments.length === 1 && segments[0]) {
    return `/api/v1/movies/${encodeURIComponent(segments[0])}/comments`;
  }
  return null;
}

async function handle(request: NextRequest, context: RouteContext) {
  let session: Session | null = null;
  try {
    session = (await auth()) as Session | null;
  } catch (e) {
    console.error("[proxy/comments] auth() threw", e);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session?.apiToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!API_BASE_URL) {
    console.error("[proxy/comments] API base URL is not configured");
    return NextResponse.json({ error: "API not configured" }, { status: 503 });
  }

  const { path } = await context.params;
  const subPath = buildTargetPath(path);
  if (!subPath) {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }
  const targetUrl = `${API_BASE_URL}${subPath}${request.nextUrl.search}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.apiToken}`,
  };

  let body: BodyInit | undefined;
  if (request.method !== "GET") {
    const text = await request.text();
    if (text) {
      body = text;
      const ct = request.headers.get("content-type");
      headers["Content-Type"] =
        ct && ct.trim() !== "" ? ct : "application/json";
    }
  }

  let apiRes: Response;
  try {
    apiRes = await fetch(targetUrl, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
    });
  } catch (e) {
    console.error("[proxy/comments] upstream fetch failed", {
      targetUrl,
      error: e,
    });
    return NextResponse.json({ error: "Bad Gateway" }, { status: 502 });
  }

  const text = await apiRes.text();
  if (!text) {
    return new NextResponse(null, { status: apiRes.status });
  }
  return new NextResponse(text, {
    status: apiRes.status,
    headers: {
      "Content-Type":
        apiRes.headers.get("content-type") ?? "application/json",
      "Cache-Control": "private, no-store, max-age=0",
    },
  });
}

export async function POST(request: NextRequest, context: RouteContext) {
  return handle(request, context);
}
export async function DELETE(request: NextRequest, context: RouteContext) {
  return handle(request, context);
}
