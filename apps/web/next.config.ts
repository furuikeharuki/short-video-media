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

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
