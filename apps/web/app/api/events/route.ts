import { NextResponse } from "next/server";

/**
 * 旧 GA4 ビーコン用 Route Handler。
 *
 * 以前はここで Measurement Protocol (mp/collect) に `client_id: "anonymous"` 固定で
 * イベントを投げていたが、これが原因で GA4 上で全イベントが 1 ユーザ
 * (activeUsers=1) に collapse し、ブラウザの gtag セッションとも切り離された
 * 「イベントのみのセッション」(landingPage 空・engagedSessions 0) を量産していた。
 *
 * GA4 送信は client 側 gtag に一本化したため (lib/analytics/ga4-client.ts)、
 * この endpoint はもう Measurement Protocol を呼ばない。デプロイ直後に古いクライアント
 * バンドルがまだ POST してくる可能性があるので、404/400 でノイズを出さないよう
 * 受理だけして握りつぶす no-op として残す。新規呼び出しは追加しないこと。
 */
export async function POST(): Promise<Response> {
  return NextResponse.json({ ok: true, deprecated: true });
}
