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

// クローラ・検索エンジンが age-gate を介さず直接取得できる必要があるファイル。
// startsWith ではなく完全一致で判定する (任意のパス prefix 化を避ける)。
const PUBLIC_EXACT_PATHS = new Set<string>([
  "/sitemap.xml",
  "/robots.txt",
]);

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 公開パスはスキップ
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // sitemap.xml / robots.txt はクローラが age 確認 cookie 無しで取得するため
  // 年齢認証より前に通過させる (検索エンジン登録時に HTML を返さないため)。
  if (PUBLIC_EXACT_PATHS.has(pathname)) {
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
