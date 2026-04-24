import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, sha256Hex } from "@/lib/auth";

// Paths that must NOT be gated.
const PUBLIC_PREFIXES = ["/login", "/api/auth"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const password = process.env.APP_PASSWORD;
  const cookie = req.cookies.get(AUTH_COOKIE)?.value;

  let authed = false;
  if (password && cookie) {
    const expected = await sha256Hex(password);
    authed = cookie === expected;
  }

  if (authed) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except Next internals, static files, and favicon.
  matcher: ["/((?!_next/|favicon.ico|robots.txt|sitemap.xml).*)"],
};
