/**
 * The session cookie's contents: a signed JWT (HS256 over RELAY_SESSION_SECRET, 30 days) carrying the GitHub
 * identity. Pure functions only; `lib/session.ts` wires them to Next's cookies and `proxy.ts` verifies with them.
 *
 * There is no server-side session store: signing out clears the cookie, and a leaked cookie is good until its
 * `exp` or until RELAY_SESSION_SECRET is rotated (which signs every session out at once).
 */
import { jwtVerify, SignJWT } from "jose";

export const SESSION_COOKIE = "relay_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const ALG = "HS256";
const ISSUER = "relay";

export interface SessionUser {
  /** GitHub login, as GitHub spells it. */
  login: string;
  name: string | null;
  avatar_url: string | null;
}

export interface Session extends SessionUser {
  /** Seconds since the epoch. */
  iat: number;
  exp: number;
  /** Set on the fake session mock mode runs with; never on a minted one. */
  demo?: boolean;
}

/** The actor string web-initiated writes are attributed to. */
export function sessionActor(s: Pick<Session, "login">): string {
  return `human:${s.login}`;
}

function key(secret: string): Uint8Array {
  if (!secret || secret.length < 16) throw new Error("RELAY_SESSION_SECRET must be set to at least 16 characters.");
  return new TextEncoder().encode(secret);
}

/** Mint a fresh session: new `iat`, new `exp`. Called on every successful sign-in, never refreshed. */
export async function mintSession(user: SessionUser, secret: string, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  return new SignJWT({ login: user.login, name: user.name ?? null, avatar_url: user.avatar_url ?? null })
    .setProtectedHeader({ alg: ALG, typ: "JWT" })
    .setIssuer(ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(iat + SESSION_TTL_SECONDS)
    .sign(key(secret));
}

/** The session a cookie value carries, or null when missing, tampered, expired, or signed with another secret. */
export async function verifySession(token: string | undefined | null, secret: string | undefined, now = Date.now()): Promise<Session | null> {
  if (!token || !secret || secret.length < 16) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: [ALG], issuer: ISSUER, currentDate: new Date(now) });
    if (typeof payload.login !== "string" || !payload.login || typeof payload.iat !== "number" || typeof payload.exp !== "number") return null;
    return {
      login: payload.login,
      name: typeof payload.name === "string" ? payload.name : null,
      avatar_url: typeof payload.avatar_url === "string" ? payload.avatar_url : null,
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

/** Parse RELAY_ALLOWED_USERS: comma-separated GitHub logins, case-insensitive, whitespace ignored. */
export function parseAllowedUsers(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** False when the list is empty: no allowlist means nobody signs in, and the sign-in page says so. */
export function isAllowedUser(login: string, raw: string | undefined): boolean {
  return parseAllowedUsers(raw).includes(login.trim().toLowerCase());
}

/** The fake session mock mode runs with so the demo works without GitHub. */
export function demoSession(now = Date.now()): Session {
  const iat = Math.floor(now / 1000);
  return { login: "demo", name: "Demo viewer", avatar_url: null, iat, exp: iat + SESSION_TTL_SECONDS, demo: true };
}
