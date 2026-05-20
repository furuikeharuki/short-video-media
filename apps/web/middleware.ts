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
// matcher (config) でも除外しているが、Edge ランタイムでパス正規化や大文字小文字、
// 末尾スラッシュなどのバリエーションがあっても確実に 200 を返せるよう、
// ここでも belt-and-suspenders で再チェックする。
const PUBLIC_FILE_NAMES = new Set<string>([
  "sitemap.xml",
  "robots.txt",
]);

function isPublicFile(pathname: string): boolean {
  // 末尾スラッシュ除去 + 小文字化 (例: "/Sitemap.XML/", "/sitemap.xml")
  const normalized = pathname.replace(/\/+$/, "").toLowerCase();
  // ベース名のみで比較する (将来 basePath/locale が付いても引っかけられるように)。
  const lastSegment = normalized.slice(normalized.lastIndexOf("/") + 1);
  return PUBLIC_FILE_NAMES.has(lastSegment);
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 公開パスはスキップ
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // sitemap.xml / robots.txt はクローラが age 確認 cookie 無しで取得するため
  // 年齢認証より前に通過させる (検索エンジン登録時に HTML を返さないため)。
  if (isPublicFile(pathname)) {
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
  // matcher は middleware を実行する対象パスを限定する。
  // _next/static, _next/image, favicon.ico, sitemap.xml, robots.txt は
  // クローラや静的配信のために middleware を一切経由させたくないので除外する。
  // (sitemap/robots はランタイムでも再判定しているが、matcher 段階でも切る)
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
