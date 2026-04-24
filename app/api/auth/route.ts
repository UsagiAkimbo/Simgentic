import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, safeEqual, sha256Hex } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    return NextResponse.json(
      { error: "APP_PASSWORD is not set on the server." },
      { status: 500 }
    );
  }

  let password: string;
  try {
    const body = (await req.json()) as { password?: unknown };
    if (typeof body.password !== "string") {
      return NextResponse.json(
        { error: "Body must be { password: string }." },
        { status: 400 }
      );
    }
    password = body.password;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!safeEqual(password, expected)) {
    // Dev-only diagnostics — lengths only, no values.
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[auth] password mismatch. submitted.length=${password.length} expected.length=${expected.length}`
      );
    }
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  const value = await sha256Hex(expected);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
