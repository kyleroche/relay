/**
 * GitHub OAuth for the browser sign-in (docs/SECURITY.md, "Signing in to the web app"). The app asks for
 * `read:user` only; the GitHub access token is used once, to read `/user`, and then dropped. What persists is the
 * relay session cookie (lib/session-token.ts).
 *
 * Environment: GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, RELAY_SESSION_SECRET, RELAY_ALLOWED_USERS.
 * GITHUB_SERVER_URL and GITHUB_API_URL (the names GitHub Actions uses) point the flow at a GitHub Enterprise Server
 * or, in tests, at a stub; unset they are github.com.
 */
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { type Env } from "./mode.ts";
import { sessionSecretOk } from "./session-token.ts";
import { SITE_URL } from "./site.ts";

export const STATE_COOKIE = "relay_oauth_state";
export const STATE_TTL_SECONDS = 10 * 60;
export const OAUTH_SCOPE = "read:user";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  serverUrl: string;
  apiUrl: string;
}

/** The OAuth app's settings, or null with the names that are missing. */
export function oauthConfig(env: Env = process.env): { config: OAuthConfig; missing: [] } | { config: null; missing: string[] } {
  const missing: string[] = [];
  if (!env.GITHUB_OAUTH_CLIENT_ID) missing.push("GITHUB_OAUTH_CLIENT_ID");
  if (!env.GITHUB_OAUTH_CLIENT_SECRET) missing.push("GITHUB_OAUTH_CLIENT_SECRET");
  if (!sessionSecretOk(env.RELAY_SESSION_SECRET)) missing.push("RELAY_SESSION_SECRET");
  if (missing.length) return { config: null, missing };
  return {
    config: {
      clientId: env.GITHUB_OAUTH_CLIENT_ID!,
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET!,
      serverUrl: (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/$/, ""),
      apiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, ""),
    },
    missing: [],
  };
}

/**
 * The origin the callback URL is built on. In production it is the configured site URL (what the GitHub OAuth app
 * has as its callback); in development it is wherever the dev server answers, so a local OAuth app works too.
 */
export function callbackUrl(req: NextRequest): string {
  const origin = process.env.NODE_ENV === "production" ? SITE_URL : req.nextUrl.origin;
  return `${origin}/auth/github/callback`;
}

/** Cookies are Secure whenever the request is https; plain http only happens on a dev server. */
export function secureCookies(req: NextRequest): boolean {
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  return proto === "https" || process.env.NODE_ENV === "production";
}

export function sameState(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface GitHubUser {
  login: string;
  name: string | null;
  avatar_url: string | null;
}

export class OAuthError extends Error {
  constructor(
    public readonly code: "exchange" | "user",
    message: string,
  ) {
    super(message);
  }
}

/** Trade the authorization code for a token and read the user behind it. */
export async function fetchGitHubUser(cfg: OAuthConfig, code: string, redirectUri: string): Promise<GitHubUser> {
  const tokenRes = await fetch(`${cfg.serverUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "relay-web" },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: redirectUri }),
    cache: "no-store",
  });
  const tokenBody = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!tokenRes.ok || !tokenBody.access_token) {
    throw new OAuthError("exchange", tokenBody.error_description ?? tokenBody.error ?? `GitHub token exchange failed (${tokenRes.status}).`);
  }
  const userRes = await fetch(`${cfg.apiUrl}/user`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${tokenBody.access_token}`, "user-agent": "relay-web", "x-github-api-version": "2022-11-28" },
    cache: "no-store",
  });
  if (!userRes.ok) throw new OAuthError("user", `GitHub /user failed (${userRes.status}).`);
  const u = (await userRes.json()) as { login?: unknown; name?: unknown; avatar_url?: unknown };
  if (typeof u.login !== "string" || !u.login) throw new OAuthError("user", "GitHub /user returned no login.");
  return {
    login: u.login,
    name: typeof u.name === "string" && u.name ? u.name : null,
    avatar_url: typeof u.avatar_url === "string" && u.avatar_url ? u.avatar_url : null,
  };
}
