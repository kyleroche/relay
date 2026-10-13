import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@/lib/access";
import { callbackUrl, OAUTH_SCOPE, oauthConfig, secureCookies, STATE_COOKIE, STATE_TTL_SECONDS } from "@/lib/github-oauth";
import { dataMode } from "@/lib/mode";

export const dynamic = "force-dynamic";

/**
 * GET /auth/github/start?next=/path — begin the GitHub sign-in: remember a random state (and where to return) in a
 * short-lived cookie and send the browser to GitHub's authorize page asking for `read:user`.
 */
export function GET(req: NextRequest): NextResponse {
  const next = safeNextPath(req.nextUrl.searchParams.get("next"));
  if (dataMode() === "mock") return NextResponse.redirect(new URL(next, req.nextUrl.origin), 303);

  const { config } = oauthConfig();
  if (!config) return NextResponse.redirect(new URL("/sign-in?error=unconfigured", req.nextUrl.origin), 303);

  const state = randomBytes(16).toString("hex");
  const authorize = new URL(`${config.serverUrl}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", config.clientId);
  authorize.searchParams.set("redirect_uri", callbackUrl(req));
  authorize.searchParams.set("scope", OAUTH_SCOPE);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", "false");

  const res = NextResponse.redirect(authorize, 303);
  res.cookies.set(STATE_COOKIE, JSON.stringify({ state, next }), {
    httpOnly: true,
    secure: secureCookies(req),
    sameSite: "lax",
    path: "/auth/",
    maxAge: STATE_TTL_SECONDS,
  });
  res.headers.set("cache-control", "no-store");
  return res;
}
