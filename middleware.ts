import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, sha256Hex } from "@/lib/auth";

// Paths that must NOT be gated.
const PUBLIC_PREFIXES = ["/login", "/api/auth"];

// Unity WebGL needs eval (framework boot) and wasm-unsafe-eval (WASM compile).
// We scope the relaxed CSP to routes that host Unity; everything else gets a
// stricter default. Add new prefixes here when Unity moves to other routes.
const UNITY_PREFIXES = ["/unity-test"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function needsUnityCsp(pathname: string): boolean {
  return UNITY_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function unityCspHeader(): string {
  return [
    "default-src 'self'",
    // Unity requires unsafe-eval; wasm-unsafe-eval is the narrower modern flag,
    // both included for browser-coverage. blob: and data: cover Unity's worker
    // and inline asset patterns.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' blob: data: https://api.anthropic.com",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "media-src 'self' blob: data:",
  ].join("; ");
}

function applySecurityHeaders(res: NextResponse, pathname: string): NextResponse {
  if (needsUnityCsp(pathname)) {
    res.headers.set("Content-Security-Policy", unityCspHeader());
  }
  return res;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) {
    return applySecurityHeaders(NextResponse.next(), pathname);
  }

  const password = process.env.APP_PASSWORD;
  const cookie = req.cookies.get(AUTH_COOKIE)?.value;

  let authed = false;
  if (password && cookie) {
    const expected = await sha256Hex(password);
    authed = cookie === expected;
  }

  if (authed) {
    return applySecurityHeaders(NextResponse.next(), pathname);
  }

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
