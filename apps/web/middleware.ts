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

// 検索エンジンクローラの User-Agent を判定する。
// 該当時は年齢確認リダイレクトをスキップして実ページを返し、
// Google が "年齢確認" を home の <title> として index しないようにする。
// (robots.txt 上は /age-gate を Disallow しているが、unauth で / を踏んだ
//  クローラを 307 で /age-gate へ飛ばすと、リダイレクト元 / のスニペット/
//  タイトルとして age-gate ページの内容を拾ってしまうため、ここで止める)
// "bot"/"crawler"/"spider"/"crawl"/"spider" など汎用語も含める。
const CRAWLER_UA_PATTERN =
  /(googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|sogou|exabot|facebot|facebookexternalhit|twitterbot|linkedinbot|applebot|petalbot|google-inspectiontool|chrome-lighthouse|adsbot-google|mediapartners-google|bot\b|crawler|spider|crawl)/i;

function isCrawler(userAgent: string | null): boolean {
  if (!userAgent) return false;
  return CRAWLER_UA_PATTERN.test(userAgent);
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // /age-gate 自体に当たった場合は素通しするが、X-Robots-Tag を付けて
  // 万一クローラが /age-gate を取得しても index 対象にさせない (page metadata の
  // robots: noindex に加え、HTTP ヘッダーレベルでも明示する)。
  if (pathname.startsWith("/age-gate")) {
    const res = NextResponse.next();
    res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    return res;
  }

  // 公開パスはスキップ
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // sitemap.xml / robots.txt はクローラが age 確認 cookie 無しで取得するため
  // 年齢認証より前に通過させる (検索エンジン登録時に HTML を返さないため)。
  if (isPublicFile(pathname)) {
    return NextResponse.next();
  }

  // 検索エンジンクローラは年齢ゲートをバイパスして実ページを取得させる。
  // これにより Google が "/" のタイトルを "年齢確認 | AV Shorts" として
  // index してしまう問題を防ぐ。クローラ判定は UA ベースで保守的に行い、
  // 通常ユーザの年齢確認フローには影響しない。
  if (isCrawler(request.headers.get("user-agent"))) {
    return NextResponse.next();
  }

  const verified = request.cookies.get("age_verified")?.value;
  if (verified === "true") {
    return NextResponse.next();
  }

  // 未認証なら age-gate へ。リダイレクト応答自体にも X-Robots-Tag を付けて、
  // クローラがこのレスポンスを辿った場合でも index 対象にしない。
  //
  // next には pathname だけでなく search も含める。`/feed?v=<slug>` のように
  // クエリで作品を指定する導線では、pathname のみだと age-gate 通過後に
  // `v` が落ちてフィード先頭に飛んでしまう。元の URL に確実に戻すため
  // pathname + search を引き継ぐ (fragment はサーバに送られないため対象外)。
  const url = request.nextUrl.clone();
  url.pathname = "/age-gate";
  url.search = "";
  url.searchParams.set("next", pathname + request.nextUrl.search);
  const redirect = NextResponse.redirect(url);
  redirect.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return redirect;
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
