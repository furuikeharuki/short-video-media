import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    apiToken: string | null;
    userId: string | null;
    provider: string | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    apiToken?: string;
    userId?: string;
    provider?: string;
  }
}
