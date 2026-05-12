import { NextRequest, NextResponse } from "next/server";

const PUBLIC_PATHS = ["/age-gate", "/favicon.ico"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isPublicPath = PUBLIC_PATHS.some((path) => pathname.startsWith(path));
  if (isPublicPath) {
    return NextResponse.next();
  }

  const ageVerified = request.cookies.get("age_verified")?.value;

  if (ageVerified === "true") {
    return NextResponse.next();
  }

  const ageGateUrl = new URL("/age-gate", request.url);
  ageGateUrl.searchParams.set("next", pathname);

  return NextResponse.redirect(ageGateUrl);
}

export const config = {
  matcher: ["/", "/movies/:path*"],
};