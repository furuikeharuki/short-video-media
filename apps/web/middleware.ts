import { NextRequest, NextResponse } from "next/server";

const PUBLIC_PATHS = [
  "/age-gate",
  "/age-gate/verify",
  "/api/",
  "/_next/",
  "/favicon",
  // NextAuthのコールバックとプロキシは年齢認証をスキップ (すでに /api/ でカバーされている)
  "/cc3e298a0904fce9fab07e30b99e9f23.html",
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 公開パスはスキップ
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const verified = request.cookies.get("age_verified")?.value;
  if (verified === "true") {
    return NextResponse.next();
  }

  // 未認証なら age-gate へ
  const url = request.nextUrl.clone();
  url.pathname = "/age-gate";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
