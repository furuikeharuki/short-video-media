import { NextRequest, NextResponse } from "next/server";

const PUBLIC_PATHS = [
  "/age-gate",
  "/api/",
  "/_next/",
  "/favicon",
  "/cc3e298a0904fce9fab07e30b99e9f23.html",
];

const PUBLIC_FILE_NAMES = new Set<string>([
  "sitemap.xml",
  "video-sitemap.xml",
  "robots.txt",
]);

function isPublicFile(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, "").toLowerCase();
  const lastSegment = normalized.slice(normalized.lastIndexOf("/") + 1);
  return PUBLIC_FILE_NAMES.has(lastSegment);
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // age-gateページ自体：noindexを付けてそのまま通す
  if (pathname.startsWith("/age-gate")) {
    const res = NextResponse.next();
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
    return res;
  }

  // 公開パス・静的ファイルはスキップ
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }
  if (isPublicFile(pathname)) {
    return NextResponse.next();
  }

  // UA でクローラだけを実ページへ通し、一般ユーザーだけ /age-gate へ
  // リダイレクトすると cloaking に見える。年齢確認は layout の
  // AgeGateOverlay で同じ HTML 上に重ね、middleware では差分配信しない。
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
