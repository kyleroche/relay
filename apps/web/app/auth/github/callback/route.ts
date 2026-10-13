import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@/lib/access";
import { callbackUrl, fetchGitHubUser, OAuthError, oauthConfig, sameState, secureCookies, STATE_COOKIE } from "@/lib/github-oauth";
import { dataMode } from "@/lib/mode";
import { isAllowedUser, mintSession, parseAllowedUsers, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/session-token";

export const dynamic = "force-dynamic";

/**
 * GET /auth/github/callback?code=&state= — finish the GitHub sign-in. The state must match the cookie `start` set,
 * the code is traded for a token, `/user` names the login, and the login must be on RELAY_ALLOWED_USERS. A new
 * session is minted on every success (fresh iat and exp); failures land on /sign-in with a reason code.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = req.nextUrl.origin;
  const fail = (error: string) => {
    const res = NextResponse.redirect(new URL(`/sign-in?error=${error}`, origin), 303);
    res.cookies.set(STATE_COOKIE, "", { path: "/auth/", maxAge: 0 });
    res.headers.set("cache-control", "no-store");
    return res;
  };
  if (dataMode() === "mock") return NextResponse.redirect(new URL("/", origin), 303);

  const { config } = oauthConfig();
  if (!config) return fail("unconfigured");

  const sp = req.nextUrl.searchParams;
  if (sp.get("error")) return fail("github");
  const code = sp.get("code");
  const state = sp.get("state");
  let stored: { state?: string; next?: string } = {};
  try {
    stored = JSON.parse(req.cookies.get(STATE_COOKIE)?.value ?? "{}") as typeof stored;
  } catch {
    stored = {};
  }
  if (!code || !state || !sameState(state, stored.state)) return fail("state");

  let user;
  try {
    user = await fetchGitHubUser(config, code, callbackUrl(req));
  } catch (e) {
    return fail(e instanceof OAuthError ? e.code : "github");
  }

  if (parseAllowedUsers(process.env.RELAY_ALLOWED_USERS).length === 0) return fail("no-allowlist");
  if (!isAllowedUser(user.login, process.env.RELAY_ALLOWED_USERS)) return fail("denied");

  const token = await mintSession(user, process.env.RELAY_SESSION_SECRET!);
  const res = NextResponse.redirect(new URL(safeNextPath(stored.next), origin), 303);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookies(req),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  res.cookies.set(STATE_COOKIE, "", { path: "/auth/", maxAge: 0 });
  res.headers.set("cache-control", "no-store");
  return res;
}
