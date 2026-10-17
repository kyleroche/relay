/**
 * The authorization server's wiring for this site (docs/SECURITY.md, "Access for agents"). The logic is
 * @relay/core's oauth/server.ts; this file supplies the issuer (SITE_URL), the feed fan-out for access.* events,
 * request parsing shared by /oauth/token, /oauth/device, /oauth/revoke and /oauth/register, and the RFC 6749 error
 * shape. Every endpoint needs the database: mock deployments answer `server_error` with a hint.
 */
import { OAuthError, type OAuthServerOptions } from "@relay/core";
import { NextResponse } from "next/server";
import { clientKey, rateHeaders, RESOURCE_METADATA_URL, takeToken, type RateState } from "@/lib/api";
import { dataMode } from "@/lib/data";
import { dispatchOne } from "@/lib/dispatch";
import { SITE_URL } from "@/lib/site";

export const ISSUER = SITE_URL;
export const AUTHORIZATION_SERVER_METADATA_URL = `${SITE_URL}/.well-known/oauth-authorization-server`;
export { RESOURCE_METADATA_URL };

export const oauthOptions = (): OAuthServerOptions => ({ issuer: ISSUER, onEvent: dispatchOne });

/** Token-style endpoints accept application/x-www-form-urlencoded (the standard) and JSON (what agents send). */
export async function readParams(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  const out: Record<string, string> = {};
  if (type.includes("application/json")) {
    try {
      const j = (await req.json()) as unknown;
      if (j && typeof j === "object" && !Array.isArray(j)) for (const [k, v] of Object.entries(j as Record<string, unknown>)) if (v !== null && v !== undefined) out[k] = Array.isArray(v) ? v.map(String).join(" ") : String(v);
    } catch {
      /* empty body */
    }
    return out;
  }
  const text = await req.text();
  for (const [k, v] of new URLSearchParams(text)) out[k] = v;
  return out;
}

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

export function oauthJson(body: unknown, status = 200, rate?: RateState, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...(rate ? rateHeaders(rate) : {}), ...headers } });
}

/** RFC 6749 §5.2 error document. Unknown errors become server_error without leaking the message. */
export function oauthError(e: unknown, rate?: RateState, instance?: string): NextResponse {
  if (e instanceof OAuthError) {
    const headers: Record<string, string> = {};
    if (e.status === 401) headers["WWW-Authenticate"] = `Basic realm="relay", error="${e.code}"`;
    return oauthJson({ ...e.toJSON(), ...(instance ? { instance } : {}) }, e.status, rate, headers);
  }
  console.error("[relay] oauth:", e instanceof Error ? e.message : e);
  return oauthJson({ error: "server_error", error_description: "Unexpected error." }, 500, rate);
}

/** Rate limit, then refuse without a database. Returns the response to send, or the rate state to continue with. */
export function oauthGate(req: Request): { rate: RateState; refused?: NextResponse } {
  const rate = takeToken(clientKey(req));
  if (rate.limited) return { rate, refused: oauthJson({ error: "slow_down", error_description: "Rate limit exceeded." }, 429, rate, { "Retry-After": String(rate.resetSeconds) }) };
  if (dataMode() !== "db") return { rate, refused: oauthJson({ error: "server_error", error_description: "This deployment has no database (mock mode); the authorization server needs one." }, 503, rate) };
  return { rate };
}

/** Rate-limit headers on a non-OAuth response (the metadata documents). */
export const rateFor = (req: Request): RateState => takeToken(clientKey(req));
