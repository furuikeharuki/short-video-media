import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const { nextPath } = await request.json().catch(() => ({ nextPath: "/" }));

  const res = NextResponse.json({ ok: true });
  res.cookies.set("age_verified", "true", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1年
  });

  return res;
}
