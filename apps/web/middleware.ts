import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "./src/session";

// Cheap gate: no session cookie → /login. The sealed-cookie validation happens
// server-side in requireOwnerId(); this only keeps anonymous requests out of pages.
const PUBLIC_PREFIXES = [
  "/login",
  "/api/login",
  "/api/health",
  "/manifest.webmanifest",
  "/sw.js",
  "/icons",
  "/favicon.ico",
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (!req.cookies.get(SESSION_COOKIE)) {
    if (pathname.startsWith("/api/")) return new NextResponse("Unauthorized", { status: 401 });
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
