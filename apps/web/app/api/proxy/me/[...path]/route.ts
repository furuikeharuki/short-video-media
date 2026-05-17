/**
 * /api/proxy/me/* → FastAPI /api/v1/me/* への薄いプロキシ。
 *
 * Auth.js セッションから apiToken を取り出して Authorization: Bearer に付与する。
 * クライアント側に JWT を露出させないための一段噛ませ。
 *
 * NOTE: ユーザー固有データなので Next.js のキャッシュ機構に乗せないよう
 *       `dynamic = "force-dynamic"` を明示する。
 */

import { NextRequest, NextResponse } from "next/server";

import { auth } from "@/auth";

// Next.js のルーティングキャッシュ・データキャッシュを無効化
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const API_BASE_URL =
  process.env.INTERNAL_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

type RouteContext = { params: Promise<{ path: string[] }> };

async function handle(request: NextRequest, context: RouteContext) {
  const session = await auth();
  if (!session?.apiToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!API_BASE_URL) {
    return NextResponse.json({ error: "API not configured" }, { status: 500 });
  }

  const { path } = await context.params;
  const subPath = path.join("/");
  const search = request.nextUrl.search;
  const targetUrl = `${API_BASE_URL}/api/v1/me/${subPath}${search}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.apiToken}`,
  };

  let body: BodyInit | undefined;
  if (request.method === "GET") {
    // GET はボディ無し
  } else {
    // DELETE / POST / PUT / PATCH すべて body 転送を許可
    const text = await request.text();
    if (text) {
      body = text;
      const ct = request.headers.get("content-type");
      headers["Content-Type"] = ct && ct.trim() !== "" ? ct : "application/json";
    }
  }

  const apiRes = await fetch(targetUrl, {
    method: request.method,
    headers,
    body,
    cache: "no-store",
  });

  // 204 / 空ボディに対応
  const text = await apiRes.text();
  if (!text) {
    return new NextResponse(null, { status: apiRes.status });
  }
  return new NextResponse(text, {
    status: apiRes.status,
    headers: {
      "Content-Type": apiRes.headers.get("content-type") ?? "application/json",
      "Cache-Control": "private, no-store, max-age=0",
    },
  });
}

export async function GET(request: NextRequest, context: RouteContext) {
  return handle(request, context);
}
export async function POST(request: NextRequest, context: RouteContext) {
  return handle(request, context);
}
export async function PUT(request: NextRequest, context: RouteContext) {
  return handle(request, context);
}
export async function PATCH(request: NextRequest, context: RouteContext) {
  return handle(request, context);
}
export async function DELETE(request: NextRequest, context: RouteContext) {
  return handle(request, context);
}
