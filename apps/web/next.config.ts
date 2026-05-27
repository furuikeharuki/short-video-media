import type { NextConfig } from "next";

/**
 * セキュリティレスポンスヘッダ。
 *
 * Google Safe Browsing / Search Console の "有害コンテンツ" 警告に対する
 * 防御策として、ブラウザ側で実行できる典型的な保護を有効化する。
 *
 * 注意:
 *  - Content-Security-Policy は ExoClick (a.magsrv.com / a.pemsrv.com) の
 *    動的スクリプト挿入と相性が悪いため、現状は強制 (Enforce) せずに
 *    Report-Only として観測のみを行う。`script-src` などには事前に
 *    広告 / 解析 ベンダの origin を含めているため、Report のみで実害は無い。
 *    違反が安定して 0 になったら enforce に切り替える。
 *  - これらのヘッダは UI 動作には影響しないが、third-party iframe 等が
 *    必要になった場合は X-Frame-Options を緩める判断が必要。
 */

// CSP Report-Only。
// `script-src` / `frame-src` には:
//  - 自サイト ('self', 'unsafe-inline' / 'unsafe-eval' は Next.js dev / ad SDK 互換のため)
//  - ExoClick: a.magsrv.com / a.pemsrv.com / *.exoclick.com (動的 ad-provider.js)
//  - Google Analytics: googletagmanager.com / google-analytics.com
// img/connect は API + 画像 CDN (DMM / FANZA, *.dmm.co.jp) も許可する。
const cspReportOnly = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  [
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "https://a.magsrv.com https://a.pemsrv.com",
    "https://*.exoclick.com https://*.exosrv.com",
    "https://www.googletagmanager.com https://www.google-analytics.com",
  ].join(" "),
  "style-src 'self' 'unsafe-inline'",
  [
    "img-src 'self' data: blob: https:",
  ].join(" "),
  [
    "media-src 'self' blob: https:",
  ].join(" "),
  [
    "connect-src 'self'",
    "https://*.google-analytics.com https://www.googletagmanager.com",
    "https://a.magsrv.com https://a.pemsrv.com",
    "https://*.exoclick.com https://*.exosrv.com",
    "https://*.dmm.co.jp https://*.dmm.com",
  ].join(" "),
  [
    "frame-src 'self'",
    "https://a.magsrv.com https://a.pemsrv.com",
    "https://*.exoclick.com https://*.exosrv.com",
  ].join(" "),
  "worker-src 'self' blob:",
  "font-src 'self' data: https:",
].join("; ");

const securityHeaders = [
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "X-Frame-Options",
    value: "SAMEORIGIN",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "magnetometer=()",
      "gyroscope=()",
      "accelerometer=()",
      "interest-cohort=()",
    ].join(", "),
  },
  // 観測のみ。違反が出たら DevTools に warning は出るが、リソース読込は阻害しない。
  {
    key: "Content-Security-Policy-Report-Only",
    value: cspReportOnly,
  },
];

/**
 * HTML ドキュメント (= 画面の "shell") に対するキャッシュ制御。
 *
 * 背景: Next の `_next/static/chunks/*.js` 等は content-hash 付きで immutable
 * だが、それを参照する HTML が CDN / ブラウザにキャッシュされてしまうと、
 * 再デプロイ後も古い HTML から古い chunk を辿り続けてしまう。実際に
 * "?vt=1 を付けると軽くなる / 画質が良くなる" という症状が出ていたのは、
 * クエリ違いでキャッシュバイパスされて最新の HTML / chunk が取れていただけで、
 * vt 自体は計測ログのトグルにすぎない (apps/web/lib/videoTiming.ts)。
 *
 * 対策として HTML に "no-cache" を付ける (no-store ではない):
 *   - no-cache: ブラウザ/中間 CDN は保存するが、毎回サーバに条件付きリクエスト
 *     を投げて 304 を取りに行く。HTML サイズ自体は小さいので 304 で済めば実害なし。
 *   - no-store: そもそも保存しない。BFCache (back/forward) まで効かなくなり
 *     UX を損なうのでここでは選ばない。
 *
 * `_next/static/*` (content-hash 付き immutable chunk) は下の source 正規表現で
 * 除外しているため、引き続き Next 既定の immutable cache が効く。
 */
const noCacheHtmlHeaders = [
  {
    key: "Cache-Control",
    value: "no-cache, must-revalidate",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      // 拡張子なしのパス (= 動的 HTML / app router page) に no-cache を付ける。
      // 以下を明示除外:
      //   - `/_next/` : Next がハッシュ付き immutable で配信する静的アセット
      //   - `/api/`   : 各 route handler が自前で Cache-Control を返している
      //                 (例: proxy/me は private, no-store)。上書きしない。
      // ファイル拡張子付き (`.html`, `.ico`, `.xml` 等) は HTML shell ではないので
      // 同じく除外する。
      {
        source: "/:path((?!_next/|api/|.*\\.).*)",
        headers: noCacheHtmlHeaders,
      },
      // ルート "/" 単体 (上の正規表現で :path が空になるケース) も拾う。
      {
        source: "/",
        headers: noCacheHtmlHeaders,
      },
    ];
  },
};

export default nextConfig;
