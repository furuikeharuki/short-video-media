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

  // ✅ クローラはCookieを持たないため、UAに関係なく無条件でバイパス
  // UA判定に頼らず、クローラが実ページを取得できるようにする
  const userAgent = request.headers.get("user-agent") ?? "";
  const CRAWLER_UA_PATTERN =
    /(googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|sogou|exabot|facebot|facebookexternalhit|twitterbot|linkedinbot|applebot|petalbot|google-inspectiontool|chrome-lighthouse|adsbot-google|mediapartners-google|bot\b|crawler|spider|crawl)/i;

  if (CRAWLER_UA_PATTERN.test(userAgent)) {
    // ✅ クローラへのレスポンスにはX-Robots-Tagを一切付けない
    return NextResponse.next();
  }

  // 認証済みユーザーはそのまま通す
  const verified = request.cookies.get("age_verified")?.value;
  if (verified === "true") {
    return NextResponse.next();
  }

  // ✅ 未認証ユーザーへのリダイレクト：X-Robots-Tagを付けない
  const url = request.nextUrl.clone();
  url.pathname = "/age-gate";
  url.search = "";
  url.searchParams.set("next", pathname + request.nextUrl.search);
  return NextResponse.redirect(url); // ← noindexヘッダーを削除
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
