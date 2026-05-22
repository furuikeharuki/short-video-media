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
import type { Session } from "next-auth";

import { auth } from "@/auth";

// Next.js のルーティングキャッシュ・データキャッシュを無効化
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const API_BASE_URL = (
  process.env.INTERNAL_API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  ""
).replace(/\/+$/, "");

type RouteContext = { params: Promise<{ path: string[] }> };

async function handle(request: NextRequest, context: RouteContext) {
  // auth() は cookie 復号失敗 (AUTH_SECRET 不整合など) で throw し得るため、
  // 未ログインと同様に 401 として返す。500 を漏らさないのが目的。
  let session: Session | null = null;
  try {
    session = (await auth()) as Session | null;
  } catch (e) {
    console.error("[proxy/me] auth() threw", e);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session?.apiToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!API_BASE_URL) {
    console.error("[proxy/me] API base URL is not configured");
    return NextResponse.json({ error: "API not configured" }, { status: 503 });
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

  let apiRes: Response;
  try {
    apiRes = await fetch(targetUrl, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
    });
  } catch (e) {
    // backend 到達失敗 (DNS / 接続拒否 / TLS 失敗など) は 502 で返す。
    // 500 のままだと未ログイン由来か backend ダウンか区別がつかない。
    console.error("[proxy/me] upstream fetch failed", { targetUrl, error: e });
    return NextResponse.json({ error: "Bad Gateway" }, { status: 502 });
  }

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
