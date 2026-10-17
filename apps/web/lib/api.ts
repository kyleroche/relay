/**
 * Shared plumbing for /api/v1/*: structured rate-limit headers, RFC 9457 problem
 * documents, bearer scopes. Route handlers wrap themselves in `api()`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { bearerOf, resolveGrant, SCOPES, type Grant, type Scope } from "@/lib/auth";
import { dataMode, publicReadEnabled, SITE_URL } from "@/lib/data";
import { SESSION_COOKIE, sessionActor, verifySession } from "@/lib/session-token";

export const RESOURCE_METADATA_URL = `${SITE_URL}/.well-known/oauth-protected-resource`;
export const AUTHORIZATION_SERVER_URL = `${SITE_URL}/.well-known/oauth-authorization-server`;

/**
 * How an agent gets access by itself, in one paragraph, for every 401 body: the error is the documentation most bots
 * read. Register (RFC 7591), then the device flow (a person approves a short code once) or an invite code, then retry.
 */
export const ACCESS_HOWTO = `You can request access yourself; no person needs to hand you a token. 1) POST ${SITE_URL}/oauth/device with client_name=<your name> and scope=<space-separated scopes> (this registers you); it returns device_code, user_code (RLAY-XXXX) and verification_uri. 2) Show the person "approve <user_code> at ${SITE_URL}/activate" and poll POST ${SITE_URL}/oauth/token with grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=…&client_id=… every 5 s until it returns access_token (24 h) and refresh_token (90 d). If the operator gave you an invite code instead, POST ${SITE_URL}/oauth/token with grant_type=urn:relay:invite&invite=<code> and skip the approval. 3) Retry with Authorization: Bearer <access_token>. Metadata: ${AUTHORIZATION_SERVER_URL}; guide: ${SITE_URL}/docs/api#access.`;

/** The same steps as data, for problem+json bodies and info documents. */
export function accessSteps(): Record<string, unknown> {
  return {
    authorization_server: AUTHORIZATION_SERVER_URL,
    resource_metadata: RESOURCE_METADATA_URL,
    register: `POST ${SITE_URL}/oauth/register (RFC 7591, public client) or let POST ${SITE_URL}/oauth/device register you with client_name`,
    device_flow: { start: `POST ${SITE_URL}/oauth/device {client_name, scope}`, approve: `the person opens ${SITE_URL}/activate and enters user_code, or a bot with tokens:write calls POST ${SITE_URL}/api/v1/access/{user_code}/approve`, poll: `POST ${SITE_URL}/oauth/token grant_type=urn:ietf:params:oauth:grant-type:device_code device_code=… client_id=…` },
    invite: `POST ${SITE_URL}/oauth/token grant_type=urn:relay:invite invite=<code from relay invite create>`,
    browser_consent: `POST ${SITE_URL}/oauth/register then GET ${SITE_URL}/oauth/authorize with PKCE S256; token at POST ${SITE_URL}/oauth/token`,
    token_lifetime: { access_seconds: 86_400, refresh_seconds: 90 * 86_400, refresh: `POST ${SITE_URL}/oauth/token grant_type=refresh_token` },
    whoami: `GET ${SITE_URL}/api/v1/whoami or the relay_whoami tool`,
    docs: `${SITE_URL}/docs/api#access`,
    fallback_for_humans: `${SITE_URL}/tokens`,
  };
}

/** `WWW-Authenticate` for every refusal: the realm, the scope wanted, and where the authorization server is (RFC 9728). */
export function bearerChallenge(scope?: string): string {
  return `Bearer realm="relay"${scope ? `, scope="${scope}"` : ""}, resource_metadata="${RESOURCE_METADATA_URL}"`;
}

export { SCOPES, type Scope };
export const RATE_LIMIT = { policyName: "default", limit: 60, windowSeconds: 60 } as const;
export const PROBLEM_TYPE = `${SITE_URL}/docs/api#errors`;

/** Scopes an anonymous caller holds when the deployment allows public read. */
export const PUBLIC_SCOPES: Scope[] = ["feed:read", "memory:read"];

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

export const bearer = bearerOf;

/**
 * The signed-in browser viewer, when the request carries a valid `relay_session` cookie and no bearer. The person
 * who can click approve on /assets gets the same scopes here, attributed as `human:<login>`. Only in db mode: mock
 * mode's fake session must not turn anonymous API callers into writers.
 */
export async function sessionGrant(req: Request): Promise<Grant | undefined> {
  if (dataMode() !== "db") return undefined;
  const cookie = req.headers.get("cookie") ?? "";
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookie);
  const session = await verifySession(m?.[1], process.env.RELAY_SESSION_SECRET);
  return session ? { scopes: [...SCOPES], actor: sessionActor(session), source: "session", name: session.login, expiresAt: new Date(session.exp * 1000).toISOString() } : undefined;
}

/** Who is calling: the token's grant, the session's, the anonymous public-read grant, or nothing. */
export async function callerGrant(req: Request): Promise<Grant | undefined> {
  const token = bearer(req);
  if (token) return resolveGrant(token);
  const session = await sessionGrant(req);
  if (session) return session;
  return publicReadEnabled() ? { scopes: PUBLIC_SCOPES, actor: "anon:web", source: "env", name: "anonymous", expiresAt: null } : undefined;
}

/** Null when allowed; otherwise the 401/403 problem to return. Read scopes pass when public read is on. */
export async function requireScope(req: Request, scope: Scope, instance: string, rate?: RateState): Promise<NextResponse | null> {
  if (PUBLIC_SCOPES.includes(scope) && publicReadEnabled()) return null;
  const token = bearer(req);
  const headers = { "WWW-Authenticate": bearerChallenge(scope), ...(rate ? rateHeaders(rate) : {}) };
  if (!token) {
    if (await sessionGrant(req)) return null;
    return problem(401, "Unauthorized", `This operation needs a bearer token with the ${scope} scope. ${ACCESS_HOWTO}`, instance, { required_scope: scope, access: accessSteps() }, headers);
  }
  const grant = await resolveGrant(token);
  if (!grant) return problem(401, "Unauthorized", `Unknown, expired or revoked token. ${ACCESS_HOWTO}`, instance, { required_scope: scope, access: accessSteps() }, headers);
  if (!grant.scopes.includes(scope)) return problem(403, "Forbidden", `Token ${grant.name} lacks the ${scope} scope. Request a new grant that includes it (same steps as a first request); scopes cannot be widened on refresh.`, instance, { scopes: grant.scopes, required_scope: scope, access: accessSteps() }, headers);
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
      const denied = await requireScope(req, opts.scope, instance, rate);
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
