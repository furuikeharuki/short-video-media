import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const nextPath = String(formData.get("nextPath") || "/");

  const response = NextResponse.redirect(new URL(nextPath, request.url));

  response.cookies.set("age_verified", "true", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });

  return response;
}