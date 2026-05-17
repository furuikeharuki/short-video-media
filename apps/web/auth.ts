/**
 * Auth.js v5 設定。Twitter (X) と Discord でログインする。
 *
 * 設計方針:
 * - provider 側の個人情報 (メール、名前、アバター) はセッションに残さない。
 * - signIn 時に provider + provider 側 sub から短期 "exchange JWT" を作り、
 *   FastAPI の /api/v1/auth/sign-in に投げて、内部 user_id + サービス用 JWT を受け取る。
 * - JWT (内部 user_id を sub に持つ) のみをセッションに保持。
 */

import NextAuth from "next-auth";
import Discord from "next-auth/providers/discord";
import Twitter from "next-auth/providers/twitter";
import { SignJWT } from "jose";

const AUTH_SECRET = process.env.AUTH_SECRET ?? "";
const API_BASE_URL =
  process.env.INTERNAL_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

const SIGNIN_AUDIENCE = "short-video-media-signin";
const EXCHANGE_TOKEN_EXPIRES_SEC = 60;

/**
 * provider + sub から短期 JWT を発行して FastAPI /auth/sign-in を叩き、
 * 内部 user_id とサービス用 JWT を取得する。
 */
async function exchangeWithApi(
  provider: "twitter" | "discord",
  sub: string,
): Promise<{ apiToken: string; userId: string } | null> {
  if (!AUTH_SECRET) {
    console.error("[auth] AUTH_SECRET is not set");
    return null;
  }
  if (!API_BASE_URL) {
    console.error("[auth] API_BASE_URL is not set");
    return null;
  }

  const secret = new TextEncoder().encode(AUTH_SECRET);
  const exchangeToken = await new SignJWT({
    purpose: "signin",
    provider,
    sub,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setAudience(SIGNIN_AUDIENCE)
    .setExpirationTime(`${EXCHANGE_TOKEN_EXPIRES_SEC}s`)
    .sign(secret);

  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/auth/sign-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exchange_token: exchangeToken }),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("[auth] sign-in failed", res.status, await res.text());
      return null;
    }
    const data = (await res.json()) as { token: string; user_id: string };
    return { apiToken: data.token, userId: data.user_id };
  } catch (e) {
    console.error("[auth] sign-in error", e);
    return null;
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  secret: AUTH_SECRET,
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 30 },
  providers: [
    Twitter({
      clientId: process.env.AUTH_TWITTER_ID,
      clientSecret: process.env.AUTH_TWITTER_SECRET,
    }),
    Discord({
      clientId: process.env.AUTH_DISCORD_ID,
      clientSecret: process.env.AUTH_DISCORD_SECRET,
    }),
  ],
  callbacks: {
    /**
     * 初回ログイン時のみ account が入る。ここで FastAPI と交換して
     * apiToken / userId を JWT に格納。以降のリクエストは token をそのまま返す。
     */
    async jwt({ token, account, profile }) {
      if (account) {
        const provider = account.provider as "twitter" | "discord";
        // provider 側ユーザーID。account.providerAccountId が標準。
        // (profile は Twitter v2 だと空だったりするので、account だけで判定する)
        const sub = account.providerAccountId || (profile as { id?: string } | undefined)?.id;
        if (sub) {
          const exchanged = await exchangeWithApi(provider, String(sub));
          if (exchanged) {
            token.apiToken = exchanged.apiToken;
            token.userId = exchanged.userId;
            token.provider = provider;
          } else {
            console.error("[auth] exchangeWithApi returned null");
          }
        } else {
          console.error("[auth] no provider sub available", { provider });
        }
        // provider 側の個人情報は一切 token に残さない
        delete (token as Record<string, unknown>).name;
        delete (token as Record<string, unknown>).email;
        delete (token as Record<string, unknown>).picture;
      }
      return token;
    },
    async session({ session, token }) {
      const t = token as {
        apiToken?: string;
        userId?: string;
        provider?: string;
      };
      // apiToken がない = API との exchange に失敗している
      // この場合は session を返さないことで「未ログイン」扱いにさせる。
      // (Vercel と Railway の AUTH_SECRET/APP_USER_SALT 不整合などで起きる)
      if (!t.apiToken || !t.userId) {
        return null as unknown as typeof session;
      }
      // 拡張プロパティを next-auth.d.ts で拡張済み
      const s = session as unknown as Record<string, unknown>;
      s.apiToken = t.apiToken;
      s.userId = t.userId;
      s.provider = t.provider ?? null;
      // provider 側の個人情報は session からも除去
      const u = (session as unknown as { user?: Record<string, unknown> }).user;
      if (u) {
        delete u.name;
        delete u.email;
        delete u.image;
      }
      return session;
    },
  },
  pages: {
    // キャンセル時や OAuth エラー時に NextAuth デフォルトの
    // /api/auth/error?error=Configuration ページ (赤い警告風の UI) を見せず、
    // 自前の優しいエラーページ (/auth/error) へ送る。
    error: "/auth/error",
  },
});
