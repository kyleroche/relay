import { NextResponse, type NextRequest } from "next/server";
import { secureCookies } from "@/lib/github-oauth";
import { SESSION_COOKIE } from "@/lib/session-token";

export const dynamic = "force-dynamic";

/** POST /auth/sign-out — clear the session cookie. There is no server-side session to revoke. */
export function POST(req: NextRequest): NextResponse {
  const res = NextResponse.redirect(new URL("/sign-in", req.nextUrl.origin), 303);
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: secureCookies(req), sameSite: "lax", path: "/", maxAge: 0 });
  res.headers.set("cache-control", "no-store");
  return res;
}
