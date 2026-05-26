import type { NextConfig } from "next";

/**
 * セキュリティレスポンスヘッダ。
 *
 * Google Safe Browsing / Search Console の "有害コンテンツ" 警告に対する
 * 防御策として、ブラウザ側で実行できる典型的な保護を有効化する。
 *
 * 注意:
 *  - Content-Security-Policy は ExoClick (a.magsrv.com / a.pemsrv.com) の
 *    動的スクリプト挿入と相性が悪いため、ここでは敢えて未設定にしている。
 *    将来広告基盤を入れ替えるなどで安全に有効化できるようになったら追加する。
 *  - これらのヘッダは UI 動作には影響しないが、third-party iframe 等が
 *    必要になった場合は X-Frame-Options を緩める判断が必要。
 */
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
