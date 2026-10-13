/**
 * Shared plumbing for /api/v1/*: structured rate-limit headers, RFC 9457 problem
 * documents, bearer scopes. Route handlers wrap themselves in `api()`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { publicReadEnabled, SITE_URL } from "@/lib/data";

export const RATE_LIMIT = { policyName: "default", limit: 60, windowSeconds: 60 } as const;

export type Scope = "feed:read" | "memory:read" | "memory:write";
export const SCOPES: Scope[] = ["feed:read", "memory:read", "memory:write"];
export const PROBLEM_TYPE = `${SITE_URL}/docs/api#errors`;

// Per-instance sliding window. Good for one region and a demo; move to a shared store
// (Upstash/Redis) before running several instances. Keyed by client IP.
const buckets = new Map<string, number[]>();

declare global {
  // eslint-disable-next-line no-var
  var __relayBuckets: Map<string, number[]> | undefined;
}
const store = (globalThis.__relayBuckets ??= buckets);

export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "anon";
  return ip;
}

export interface RateState {
  remaining: number;
  resetSeconds: number;
  limited: boolean;
}

export function takeToken(key: string, now = Date.now()): RateState {
  const windowMs = RATE_LIMIT.windowSeconds * 1000;
  const hits = (store.get(key) ?? []).filter((t) => now - t < windowMs);
  const oldest = hits[0];
  const resetSeconds = oldest ? Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) : RATE_LIMIT.windowSeconds;
  if (hits.length >= RATE_LIMIT.limit) {
    store.set(key, hits);
    return { remaining: 0, resetSeconds, limited: true };
  }
  hits.push(now);
  store.set(key, hits);
  if (store.size > 5000) store.clear(); // crude memory cap
  return { remaining: RATE_LIMIT.limit - hits.length, resetSeconds, limited: false };
}

export function rateHeaders(state: RateState): Record<string, string> {
  return {
    "RateLimit-Policy": `"${RATE_LIMIT.policyName}";q=${RATE_LIMIT.limit};w=${RATE_LIMIT.windowSeconds}`,
    RateLimit: `"${RATE_LIMIT.policyName}";r=${state.remaining};t=${state.resetSeconds}`,
  };
}

export function problem(
  status: number,
  title: string,
  detail: string,
  instance: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(
    { type: PROBLEM_TYPE, title, status, detail, instance, ...extra },
    { status, headers: { "content-type": "application/problem+json; charset=utf-8", "cache-control": "no-store", ...headers } },
  );
}

/** Tokens from RELAY_API_TOKENS="token:scope,scope;token2:scope". Minted by the CLI, never here. */
function tokenScopes(token: string): Scope[] | null {
  const raw = process.env.RELAY_API_TOKENS;
  if (!raw) return null;
  for (const entry of raw.split(";")) {
    const [t, scopes] = entry.split(":");
    if (t?.trim() === token) return (scopes ?? "").split(",").map((s) => s.trim()).filter((s): s is Scope => SCOPES.includes(s as Scope));
  }
  return null;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1]?.trim() ?? null;
}

/** Null when allowed; otherwise the 401/403 problem to return. Read scopes pass when public read is on. */
export function requireScope(req: Request, scope: Scope, instance: string, rate?: RateState): NextResponse | null {
  if (scope !== "memory:write" && publicReadEnabled()) return null;
  const token = bearer(req);
  const challenge = `Bearer realm="relay", scope="${scope}", resource_metadata="${SITE_URL}/.well-known/oauth-protected-resource"`;
  const headers = { "WWW-Authenticate": challenge, ...(rate ? rateHeaders(rate) : {}) };
  if (!token) return problem(401, "Unauthorized", `This operation needs a bearer token with the ${scope} scope.`, instance, {}, headers);
  const granted = tokenScopes(token);
  if (!granted) return problem(401, "Unauthorized", "Unknown token.", instance, {}, headers);
  if (!granted.includes(scope)) return problem(403, "Forbidden", `Token lacks the ${scope} scope.`, instance, { scopes: granted }, headers);
  return null;
}

type Handler<C> = (req: NextRequest, ctx: C, rate: RateState) => Promise<NextResponse> | NextResponse;

/** Wrap a route handler: rate limit, uniform headers, errors as problem+json. */
export function api<C>(handler: Handler<C>, opts: { scope?: Scope } = {}) {
  return async (req: NextRequest, ctx: C): Promise<NextResponse> => {
    const instance = new URL(req.url).pathname;
    const rate = takeToken(clientKey(req));
    if (rate.limited) {
      return problem(429, "Too Many Requests", `Rate limit of ${RATE_LIMIT.limit} requests per ${RATE_LIMIT.windowSeconds}s exceeded.`, instance, {}, {
        ...rateHeaders(rate),
        "Retry-After": String(rate.resetSeconds),
      });
    }
    if (opts.scope) {
      const denied = requireScope(req, opts.scope, instance, rate);
      if (denied) return denied;
    }
    try {
      const res = await handler(req, ctx, rate);
      for (const [k, v] of Object.entries(rateHeaders(rate))) res.headers.set(k, v);
      if (!res.headers.has("cache-control")) res.headers.set("cache-control", "no-store");
      return res;
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Unexpected error.";
      return problem(500, "Internal Server Error", detail, instance, {}, rateHeaders(rate));
    }
  };
}

export function json(body: unknown, init: ResponseInit = {}): NextResponse {
  return NextResponse.json(body, init);
}
