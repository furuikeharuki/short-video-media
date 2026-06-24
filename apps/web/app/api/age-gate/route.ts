import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  return NextResponse.json({
    verified: request.cookies.get("age_verified")?.value === "true",
  });
}

export async function POST(request: NextRequest) {
  await request.json().catch(() => null);

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
