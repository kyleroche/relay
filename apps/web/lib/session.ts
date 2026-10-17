/**
 * The signed-in viewer, for server components, server actions and route handlers.
 *
 *   getSession()      the session the `relay_session` cookie carries, or null. In mock mode (`RELAY_DATA=mock`, or no
 *                     DATABASE_URL with RELAY_DATA unset) it is the fake `human:demo` session so the demo works.
 *   requireSession()  the same, or a redirect to /sign-in?next=<current path> when there is none.
 *   viewerActor()     `human:<login>` for attributing web-initiated writes. RELAY_REVIEWER overrides it in mock mode only.
 *
 * `proxy.ts` does the same cookie check for every protected request before a page renders; these helpers are for
 * the code that needs to know who the viewer is.
 */
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isCrossSite } from "./fetch-site.ts";
import { dataMode } from "./mode.ts";
import { demoSession, SESSION_COOKIE, sessionActor, verifySession, type Session } from "./session-token.ts";

export { SESSION_COOKIE, sessionActor, type Session, type SessionUser } from "./session-token.ts";

export function sessionSecret(): string | undefined {
  return process.env.RELAY_SESSION_SECRET;
}

export async function getSession(): Promise<Session | null> {
  if (dataMode() === "mock") return demoSession();
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value, sessionSecret());
}

/** The session, or a redirect to the sign-in page that returns here afterwards. */
export async function requireSession(next?: string): Promise<Session> {
  const session = await getSession();
  if (session) return session;
  const target = next ?? (await currentPath());
  redirect(`/sign-in?next=${encodeURIComponent(target)}`);
}

/** Attribution for a write the viewer makes in the browser. Throws when nobody is signed in. */
export async function viewerActor(): Promise<string> {
  const session = await getSession();
  if (!session) throw new Error("Sign in to do that.");
  if (session.demo && process.env.RELAY_REVIEWER) return process.env.RELAY_REVIEWER;
  return sessionActor(session);
}

/** True when the current request says `Sec-Fetch-Site: cross-site` (lib/fetch-site.ts); false outside a request. */
export async function requestIsCrossSite(): Promise<boolean> {
  try {
    return isCrossSite(await headers());
  } catch {
    return false;
  }
}

/** The path the request is for, from the header proxy.ts sets; "/" when called outside a request. */
async function currentPath(): Promise<string> {
  try {
    const h = await headers();
    return h.get("x-relay-path") ?? "/";
  } catch {
    return "/";
  }
}
