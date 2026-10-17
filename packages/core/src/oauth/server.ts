/**
 * The authorization server, independent of any HTTP framework: the web app's `/oauth/*` routes parse the request and
 * call one function here; the tests call the same functions with an in-memory database. It implements OAuth 2.1 with
 * PKCE (S256 only), RFC 7591 dynamic client registration, RFC 8628 device authorization, RFC 7009 revocation, refresh
 * token rotation with reuse detection, and relay's own `urn:relay:invite` grant for approvals without a browser.
 *
 * Access tokens are ordinary rows in `tokens` (name `oauth:<client name>`, 24 h, hash stored), so `findToken`, the
 * scope checks and `relay token ls|revoke` see them like any other token. Refresh tokens live in
 * `oauth_refresh_tokens` (90 d, hash stored, rotated on every use).
 */
import { randomBytes } from "node:crypto";
import type { Db } from "../db/client.ts";
import { writeEvent, type EventRow } from "../db/events.ts";
import * as q from "../db/oauth.ts";
import { createToken, getTokenById, hashToken, isTokenScope, revokeTokenByHash, revokeTokenById, TOKEN_SCOPE_DESCRIPTIONS, TOKEN_SCOPES, type TokenRow, type TokenScope } from "../db/tokens.ts";
import { newUserCode, normalizeUserCode, opaqueSecret, parseScopeParam, redirectUriMatches, scopeString, sha256hex, validRedirectUri, verifyPkce } from "./codes.ts";

export const ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
export const AUTH_CODE_TTL_SECONDS = 10 * 60;
export const DEVICE_CODE_TTL_SECONDS = 15 * 60;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
export const INVITE_DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export const GRANT_AUTHORIZATION_CODE = "authorization_code";
export const GRANT_REFRESH_TOKEN = "refresh_token";
export const GRANT_DEVICE_CODE = "urn:ietf:params:oauth:grant-type:device_code";
export const GRANT_INVITE = "urn:relay:invite";
export const GRANT_TYPES = [GRANT_AUTHORIZATION_CODE, GRANT_REFRESH_TOKEN, GRANT_DEVICE_CODE, GRANT_INVITE] as const;

/** Event kinds the server writes so approvals can be relayed and audited (docs/FEED.md). */
export const ACCESS_EVENT_KINDS = ["access.requested", "access.granted", "access.denied", "access.revoked", "access.invite_created", "access.invite_revoked", "access.client_removed", "access.purged"] as const;

export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "invalid_target"
  | "access_denied"
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "server_error";

/** RFC 6749 §5.2 error, with the HTTP status the token endpoint should answer with. */
export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    readonly description: string,
    readonly status: 400 | 401 | 403 | 500 = 400,
  ) {
    super(`${code}: ${description}`);
    this.name = "OAuthError";
  }
  toJSON(): { error: OAuthErrorCode; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}

export interface OAuthServerOptions {
  /** The site's origin, e.g. https://relay.example.com. Also the only accepted `resource`. */
  issuer: string;
  now?: () => number;
  /** Called with every feed row the server writes (the web app fans webhooks out from here). */
  onEvent?: (row: EventRow) => void | Promise<void>;
}

const nowMs = (o: OAuthServerOptions): number => (o.now ?? Date.now)();
const after = (o: OAuthServerOptions, seconds: number): Date => new Date(nowMs(o) + seconds * 1000);
const isPast = (o: OAuthServerOptions, iso: string): boolean => new Date(iso).getTime() <= nowMs(o);

/** RFC 8414 metadata. `scopes_supported` is TOKEN_SCOPES; the device flow's verification page is /activate. */
export function authorizationServerMetadata(issuer: string): Record<string, unknown> {
  const base = issuer.replace(/\/+$/, "");
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    device_authorization_endpoint: `${base}/oauth/device`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: [...TOKEN_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: [...GRANT_TYPES],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    service_documentation: `${base}/docs/integrations`,
    ui_locales_supported: ["en"],
    "relay:invite_grant": GRANT_INVITE,
    "relay:verification_uri": `${base}/activate`,
  };
}

/** RFC 9728: the resource (this site's API and MCP server) names its authorization server (this site). */
export function protectedResourceMetadata(issuer: string): Record<string, unknown> {
  const base = issuer.replace(/\/+$/, "");
  return {
    resource: base,
    authorization_servers: [base],
    scopes_supported: [...TOKEN_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "relay",
    resource_documentation: `${base}/docs/api#authentication-and-scopes`,
    resource_policy_uri: `${base}/privacy`,
  };
}

// ---------- scopes ----------

/** Validate requested scopes against the catalogue and, when a client registered a ceiling, against it. */
export function resolveScopes(raw: string | string[] | null | undefined, client?: Pick<q.OAuthClientRow, "scopes"> | null, fallback: readonly string[] = TOKEN_SCOPES): TokenScope[] {
  const requested = parseScopeParam(raw);
  const list = requested.length ? requested : [...fallback];
  const bad = list.filter((s) => !isTokenScope(s));
  if (bad.length) throw new OAuthError("invalid_scope", `Unknown scope(s): ${bad.join(", ")}. Valid: ${TOKEN_SCOPES.join(", ")}.`);
  if (client?.scopes.length) {
    const over = list.filter((s) => !client.scopes.includes(s));
    if (over.length) throw new OAuthError("invalid_scope", `This client may not request ${over.join(", ")}.`);
  }
  return list as TokenScope[];
}

export const scopeDescriptions = (scopes: readonly string[]): Array<{ scope: string; description: string }> =>
  scopes.map((s) => ({ scope: s, description: isTokenScope(s) ? TOKEN_SCOPE_DESCRIPTIONS[s] : "" }));

/** RFC 8707: a `resource` is accepted when it is this site (or a path on it, such as /mcp). */
function checkResource(o: OAuthServerOptions, resource: string | null | undefined): string | null {
  if (!resource) return null;
  let u: URL;
  try {
    u = new URL(resource);
  } catch {
    throw new OAuthError("invalid_target", "resource must be an absolute URL.");
  }
  const issuer = new URL(o.issuer);
  if (u.origin !== issuer.origin) throw new OAuthError("invalid_target", `This server issues tokens for ${issuer.origin} only.`);
  return resource;
}

// ---------- RFC 7591 dynamic client registration ----------

export interface ClientRegistrationRequest {
  client_name?: unknown;
  redirect_uris?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  token_endpoint_auth_method?: unknown;
  scope?: unknown;
  software_id?: unknown;
  client_uri?: unknown;
}

export interface ClientRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at: number;
  client_secret_expires_at?: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope: string;
  software_id?: string;
  client_uri?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const strList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : typeof v === "string" ? [v.trim()].filter(Boolean) : undefined);

/** Register a client. Public by default (`none`); `client_secret_post` gets a secret shown once. */
export async function registerClient(db: Db, body: ClientRegistrationRequest, o: OAuthServerOptions, createdBy = "anon:oauth"): Promise<ClientRegistrationResponse> {
  const name = str(body.client_name);
  if (!name) throw new OAuthError("invalid_client_metadata", "client_name is required.");
  if (name.length > 80) throw new OAuthError("invalid_client_metadata", "client_name must be at most 80 characters.");
  const grantTypes = strList(body.grant_types) ?? [GRANT_AUTHORIZATION_CODE, GRANT_REFRESH_TOKEN];
  const unknownGrant = grantTypes.filter((g) => !(GRANT_TYPES as readonly string[]).includes(g));
  if (unknownGrant.length) throw new OAuthError("invalid_client_metadata", `Unsupported grant_types: ${unknownGrant.join(", ")}.`);
  const responseTypes = strList(body.response_types) ?? (grantTypes.includes(GRANT_AUTHORIZATION_CODE) ? ["code"] : []);
  if (responseTypes.some((r) => r !== "code")) throw new OAuthError("invalid_client_metadata", "Only response_type=code is supported.");
  const redirectUris = strList(body.redirect_uris) ?? [];
  if (grantTypes.includes(GRANT_AUTHORIZATION_CODE) && !redirectUris.length) throw new OAuthError("invalid_redirect_uri", "redirect_uris is required for the authorization_code grant.");
  const badUri = redirectUris.filter((u) => !validRedirectUri(u));
  if (badUri.length) throw new OAuthError("invalid_redirect_uri", `Redirect URIs must be https, loopback http, or a private-use scheme: ${badUri.join(", ")}.`);
  const method = str(body.token_endpoint_auth_method) ?? "none";
  if (method !== "none" && method !== "client_secret_post") throw new OAuthError("invalid_client_metadata", "token_endpoint_auth_method must be none or client_secret_post.");
  const scopes = resolveScopes(str(body.scope), null);
  const secret = method === "client_secret_post" ? opaqueSecret("rcs_") : undefined;
  const clientId = "rc_" + randomBytes(12).toString("base64url");
  const row = await q.insertClient(db, {
    client_id: clientId,
    client_secret_hash: secret ? sha256hex(secret) : null,
    name,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    token_endpoint_auth_method: method,
    scopes,
    software_id: str(body.software_id) ?? null,
    client_uri: str(body.client_uri) ?? null,
    created_by: createdBy,
  });
  const out: ClientRegistrationResponse = {
    client_id: row.client_id,
    client_id_issued_at: Math.floor(nowMs(o) / 1000),
    client_name: row.name,
    redirect_uris: row.redirect_uris,
    grant_types: row.grant_types,
    response_types: responseTypes,
    token_endpoint_auth_method: row.token_endpoint_auth_method,
    scope: scopeString(row.scopes),
  };
  if (secret) {
    out.client_secret = secret;
    out.client_secret_expires_at = 0;
  }
  if (row.software_id) out.software_id = row.software_id;
  if (row.client_uri) out.client_uri = row.client_uri;
  return out;
}

// ---------- authorization endpoint ----------

export interface AuthorizeParams {
  response_type?: string | null;
  client_id?: string | null;
  redirect_uri?: string | null;
  scope?: string | null;
  state?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  resource?: string | null;
}

/** A validated authorization request: what the consent page shows and what `issueCode` needs. */
export interface AuthorizeRequest {
  client: q.OAuthClientRow;
  redirect_uri: string;
  scopes: TokenScope[];
  state: string | null;
  code_challenge: string;
  code_challenge_method: "S256";
  resource: string | null;
}

/**
 * Validate the query of GET /oauth/authorize. Errors about the client or redirect URI must not redirect (an attacker
 * could pick the target), so they throw; errors the client can hear about come back as `redirectError`.
 */
export async function validateAuthorizeRequest(db: Db, p: AuthorizeParams, o: OAuthServerOptions): Promise<{ request: AuthorizeRequest } | { redirectError: string }> {
  const clientId = str(p.client_id);
  if (!clientId) throw new OAuthError("invalid_request", "client_id is required.");
  const client = await q.getClient(db, clientId);
  if (!client) throw new OAuthError("invalid_client", "Unknown client_id. Register with POST /oauth/register first.", 401);
  const redirectUri = str(p.redirect_uri);
  if (!redirectUri) throw new OAuthError("invalid_request", "redirect_uri is required.");
  if (!client.redirect_uris.some((r) => redirectUriMatches(r, redirectUri))) throw new OAuthError("invalid_redirect_uri", "redirect_uri is not registered for this client.");
  const state = str(p.state) ?? null;
  const fail = (code: OAuthErrorCode, description: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", code);
    u.searchParams.set("error_description", description);
    if (state) u.searchParams.set("state", state);
    return { redirectError: u.toString() };
  };
  if (str(p.response_type) !== "code") return fail("invalid_request", "response_type must be code.");
  if (!client.grant_types.includes(GRANT_AUTHORIZATION_CODE)) return fail("unauthorized_client", "This client is not registered for the authorization_code grant.");
  const challenge = str(p.code_challenge);
  if (!challenge) return fail("invalid_request", "code_challenge is required (PKCE).");
  if ((str(p.code_challenge_method) ?? "S256") !== "S256") return fail("invalid_request", "code_challenge_method must be S256.");
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(challenge)) return fail("invalid_request", "code_challenge is not a valid S256 challenge.");
  let scopes: TokenScope[];
  let resource: string | null;
  try {
    scopes = resolveScopes(p.scope, client);
    resource = checkResource(o, p.resource);
  } catch (e) {
    if (e instanceof OAuthError) return fail(e.code, e.description);
    throw e;
  }
  return { request: { client, redirect_uri: redirectUri, scopes, state, code_challenge: challenge, code_challenge_method: "S256", resource } };
}

/** The viewer approved: mint a code and return the redirect URL that carries it. */
export async function issueAuthorizationCode(db: Db, r: AuthorizeRequest, actor: string, o: OAuthServerOptions): Promise<string> {
  const code = opaqueSecret("rac_");
  await q.insertCode(db, {
    code,
    client_id: r.client.client_id,
    redirect_uri: r.redirect_uri,
    scopes: r.scopes,
    code_challenge: r.code_challenge,
    code_challenge_method: r.code_challenge_method,
    resource: r.resource,
    actor,
    expires_at: after(o, AUTH_CODE_TTL_SECONDS),
  });
  const u = new URL(r.redirect_uri);
  u.searchParams.set("code", code);
  if (r.state) u.searchParams.set("state", r.state);
  u.searchParams.set("iss", o.issuer);
  return u.toString();
}

/** The viewer denied: the redirect URL with `error=access_denied`. */
export function denyAuthorization(r: Pick<AuthorizeRequest, "redirect_uri" | "state">): string {
  const u = new URL(r.redirect_uri);
  u.searchParams.set("error", "access_denied");
  u.searchParams.set("error_description", "The person declined.");
  if (r.state) u.searchParams.set("state", r.state);
  return u.toString();
}

// ---------- token endpoint ----------

export interface TokenParams {
  grant_type?: string | null;
  client_id?: string | null;
  client_secret?: string | null;
  code?: string | null;
  redirect_uri?: string | null;
  code_verifier?: string | null;
  refresh_token?: string | null;
  device_code?: string | null;
  scope?: string | null;
  resource?: string | null;
  /** urn:relay:invite */
  invite?: string | null;
  client_name?: string | null;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
  /** relay additions so a CLI can show what it got without another call. */
  token_name: string;
  expires_at: string;
}

/** Mint an access token (a `tokens` row) and its refresh token. `tokenName` is `oauth:<client name>`. */
async function mint(db: Db, o: OAuthServerOptions, input: { tokenName: string; scopes: TokenScope[]; actor: string; clientId: string; rotatedFrom?: string | null }): Promise<{ response: TokenResponse; row: TokenRow }> {
  const expiresAt = after(o, ACCESS_TOKEN_TTL_SECONDS);
  const { token, row } = await createToken(db, { name: input.tokenName, scopes: input.scopes, createdBy: input.actor, expiresAt, clientId: input.clientId });
  const refresh = opaqueSecret("rrt_");
  await q.insertRefreshToken(db, { token: refresh, client_id: input.clientId, access_token_id: row.id, scopes: input.scopes, actor: input.actor, expires_at: after(o, REFRESH_TOKEN_TTL_SECONDS), rotated_from: input.rotatedFrom ?? null });
  return {
    response: { access_token: token, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refresh, scope: scopeString(input.scopes), token_name: row.name, expires_at: expiresAt.toISOString() },
    row,
  };
}

async function emit(db: Db, o: OAuthServerOptions | undefined, ev: { kind: (typeof ACCESS_EVENT_KINDS)[number]; actor: string; summary: string; payload: Record<string, unknown>; dedupe_key?: string }): Promise<void> {
  const row = await writeEvent(db, { ...ev, project: null }).catch(() => undefined);
  if (row && o?.onEvent) await Promise.resolve(o.onEvent(row)).catch(() => {});
}

export const tokenNameFor = (clientName: string): string => `oauth:${clientName}`;

/** Resolve the client for a token request and authenticate it when it is confidential. */
async function authenticateClient(db: Db, p: TokenParams, requireId = true): Promise<q.OAuthClientRow | undefined> {
  const clientId = str(p.client_id);
  if (!clientId) {
    if (requireId) throw new OAuthError("invalid_client", "client_id is required.", 401);
    return undefined;
  }
  const client = await q.getClient(db, clientId);
  if (!client) throw new OAuthError("invalid_client", "Unknown client_id.", 401);
  if (client.has_secret && !(await q.clientSecretMatches(db, clientId, str(p.client_secret)))) throw new OAuthError("invalid_client", "client_secret does not match.", 401);
  return client;
}

/** POST /oauth/token: every grant in one place. Throws OAuthError with the status to answer. */
export async function exchangeToken(db: Db, p: TokenParams, o: OAuthServerOptions): Promise<TokenResponse> {
  const grant = str(p.grant_type);
  if (!grant) throw new OAuthError("invalid_request", "grant_type is required.");

  if (grant === GRANT_AUTHORIZATION_CODE) {
    const client = (await authenticateClient(db, p))!;
    const code = str(p.code);
    if (!code) throw new OAuthError("invalid_request", "code is required.");
    const row = await q.consumeCode(db, code);
    if (!row) throw new OAuthError("invalid_grant", "Unknown, used or revoked authorization code.");
    if (row.client_id !== client.client_id) throw new OAuthError("invalid_grant", "The code was issued to another client.");
    if (isPast(o, row.expires_at)) throw new OAuthError("invalid_grant", "The authorization code expired.");
    const redirectUri = str(p.redirect_uri);
    if (redirectUri && redirectUri !== row.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request.");
    if (!verifyPkce(str(p.code_verifier), row.code_challenge, row.code_challenge_method)) throw new OAuthError("invalid_grant", "code_verifier does not match code_challenge.");
    checkResource(o, p.resource);
    const { response, row: tok } = await mint(db, o, { tokenName: tokenNameFor(client.name), scopes: row.scopes as TokenScope[], actor: row.actor, clientId: client.client_id });
    await emit(db, o, { kind: "access.granted", actor: row.actor, summary: `${client.name} received a token (${scopeString(row.scopes)})`, payload: { via: "authorization_code", client_id: client.client_id, token_id: tok.id, scopes: row.scopes } });
    return response;
  }

  if (grant === GRANT_REFRESH_TOKEN) {
    const presented = str(p.refresh_token);
    if (!presented) throw new OAuthError("invalid_request", "refresh_token is required.");
    const rt = await q.getRefreshToken(db, presented);
    if (!rt) throw new OAuthError("invalid_grant", "Unknown refresh token.");
    const client = await q.getClient(db, rt.client_id);
    const presentedClient = str(p.client_id);
    if (presentedClient && presentedClient !== rt.client_id) throw new OAuthError("invalid_grant", "The refresh token belongs to another client.");
    if (client?.has_secret && !(await q.clientSecretMatches(db, client.client_id, str(p.client_secret)))) throw new OAuthError("invalid_client", "client_secret does not match.", 401);
    if (rt.revoked_at) throw new OAuthError("invalid_grant", "The refresh token was revoked.");
    if (rt.used_at) {
      // A second use means the token leaked: cut the whole lineage, access tokens included.
      const ids = await q.revokeRefreshLineage(db, rt.token_hash);
      for (const id of ids) await revokeTokenById(db, id);
      await emit(db, o, { kind: "access.revoked", actor: rt.actor, summary: `Refresh token reuse detected for ${client?.name ?? rt.client_id}; lineage revoked`, payload: { client_id: rt.client_id, reason: "refresh_reuse", revoked_tokens: ids } });
      throw new OAuthError("invalid_grant", "The refresh token was already used; the grant has been revoked. Authorize again.");
    }
    if (isPast(o, rt.expires_at)) throw new OAuthError("invalid_grant", "The refresh token expired.");
    // Validate everything the client asked for before spending the token: a bad request must not cost the grant.
    const requested = str(p.scope) ? resolveScopes(p.scope, null, rt.scopes) : (rt.scopes as TokenScope[]);
    const over = requested.filter((s) => !rt.scopes.includes(s));
    if (over.length) throw new OAuthError("invalid_scope", `A refresh may narrow scopes, not widen them: ${over.join(", ")}.`);
    checkResource(o, p.resource);
    if (!(await q.useRefreshToken(db, rt.token_hash))) throw new OAuthError("invalid_grant", "The refresh token was already used.");
    // The new access token keeps the old one's name (an invite's token stays oauth:<invite name>).
    const previous = rt.access_token_id ? await getTokenById(db, rt.access_token_id) : undefined;
    if (rt.access_token_id) await revokeTokenById(db, rt.access_token_id);
    const { response } = await mint(db, o, { tokenName: previous?.name ?? tokenNameFor(client?.name ?? rt.client_id), scopes: requested, actor: rt.actor, clientId: rt.client_id, rotatedFrom: rt.token_hash });
    return response;
  }

  if (grant === GRANT_DEVICE_CODE) {
    const deviceCode = str(p.device_code);
    if (!deviceCode) throw new OAuthError("invalid_request", "device_code is required.");
    const d = await q.getDeviceByCode(db, deviceCode);
    if (!d) throw new OAuthError("invalid_grant", "Unknown device_code.");
    const presentedClient = str(p.client_id);
    if (presentedClient && presentedClient !== d.client_id) throw new OAuthError("invalid_grant", "The device code belongs to another client.");
    if (isPast(o, d.expires_at) && d.status === "pending") throw new OAuthError("expired_token", "The device code expired; start again.");
    const now = new Date(nowMs(o));
    const tooSoon = d.last_polled_at && (now.getTime() - new Date(d.last_polled_at).getTime()) / 1000 < d.interval_seconds;
    await q.touchDevicePoll(db, d.device_code_hash, now);
    if (d.status === "pending") {
      if (tooSoon) throw new OAuthError("slow_down", `Poll at most every ${d.interval_seconds} seconds.`);
      throw new OAuthError("authorization_pending", `Waiting for ${d.user_code} to be approved at ${o.issuer}/activate.`);
    }
    if (d.status === "denied") throw new OAuthError("access_denied", "The request was denied.");
    if (d.status === "redeemed") throw new OAuthError("invalid_grant", "The device code was already redeemed.");
    const client = (await q.getClient(db, d.client_id))!;
    const actor = d.actor ?? "human:unknown";
    const { response, row: tok } = await mint(db, o, { tokenName: tokenNameFor(client.name), scopes: d.scopes as TokenScope[], actor, clientId: client.client_id });
    if (!(await q.redeemDevice(db, d.device_code_hash, tok.id))) {
      await revokeTokenById(db, tok.id);
      throw new OAuthError("invalid_grant", "The device code was already redeemed.");
    }
    await emit(db, o, { kind: "access.granted", actor, summary: `${client.name} received a token via ${d.user_code} (${scopeString(d.scopes)})`, payload: { via: "device_code", user_code: d.user_code, client_id: client.client_id, token_id: tok.id, scopes: d.scopes }, dedupe_key: `access:${d.user_code}:granted` });
    return response;
  }

  if (grant === GRANT_INVITE) {
    const code = str(p.invite);
    if (!code) throw new OAuthError("invalid_request", "invite is required.");
    const invite = await q.getInviteByCode(db, code);
    if (!invite) throw new OAuthError("invalid_grant", "Unknown invite code.");
    const spent = await q.consumeInvite(db, code, new Date(nowMs(o)));
    if (!spent) {
      const why = invite.revoked_at ? "was revoked" : isPast(o, invite.expires_at) ? "expired" : "has no uses left";
      throw new OAuthError("invalid_grant", `The invite ${why}.`);
    }
    // The invite names the token; a client registered for the call is optional and only labels the lineage.
    const client = str(p.client_id) ? await authenticateClient(db, p, false) : undefined;
    const clientId = client?.client_id ?? (await ensureInviteClient(db, str(p.client_name) ?? invite.name)).client_id;
    const actor = `invite:${invite.id}`;
    const { response, row: tok } = await mint(db, o, { tokenName: tokenNameFor(invite.name), scopes: invite.scopes as TokenScope[], actor, clientId });
    await emit(db, o, { kind: "access.granted", actor: invite.created_by, summary: `${invite.name} redeemed invite ${invite.id} (${scopeString(invite.scopes)}; ${spent.uses_left} use(s) left)`, payload: { via: "invite", invite_id: invite.id, token_id: tok.id, scopes: invite.scopes, uses_left: spent.uses_left } });
    return response;
  }

  throw new OAuthError("unsupported_grant_type", `grant_type must be one of ${GRANT_TYPES.join(", ")}.`);
}

/** A public client row that labels tokens redeemed from invites or minted for a device flow without prior registration. */
async function ensureInviteClient(db: Db, name: string): Promise<q.OAuthClientRow> {
  const id = `rc_invite_${sha256hex(name).slice(0, 16)}`;
  return (await q.getClient(db, id)) ?? q.insertClient(db, { client_id: id, name, redirect_uris: [], grant_types: [GRANT_INVITE, GRANT_REFRESH_TOKEN], token_endpoint_auth_method: "none", scopes: [], created_by: "system:invite" });
}

// ---------- RFC 8628 device authorization ----------

export interface DeviceAuthorizationParams {
  client_id?: string | null;
  /** Without client_id: register a public client with this name on the fly (what `relay setup --site` sends). */
  client_name?: string | null;
  scope?: string | null;
}

export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
  client_id: string;
}

export async function deviceAuthorization(db: Db, p: DeviceAuthorizationParams, o: OAuthServerOptions): Promise<DeviceAuthorizationResponse> {
  let client: q.OAuthClientRow | undefined;
  if (str(p.client_id)) {
    client = await q.getClient(db, str(p.client_id)!);
    if (!client) throw new OAuthError("invalid_client", "Unknown client_id.", 401);
    if (!client.grant_types.includes(GRANT_DEVICE_CODE)) throw new OAuthError("unauthorized_client", "This client is not registered for the device_code grant.");
  } else {
    const name = str(p.client_name);
    if (!name) throw new OAuthError("invalid_request", "client_id or client_name is required.");
    if (name.length > 80) throw new OAuthError("invalid_request", "client_name must be at most 80 characters.");
    client = await q.insertClient(db, { client_id: "rc_" + randomBytes(12).toString("base64url"), name, redirect_uris: [], grant_types: [GRANT_DEVICE_CODE, GRANT_REFRESH_TOKEN], token_endpoint_auth_method: "none", scopes: [], created_by: "anon:device" });
  }
  const scopes = resolveScopes(p.scope, client);
  let userCode = newUserCode();
  for (let i = 0; i < 5 && (await q.userCodeTaken(db, userCode)); i++) userCode = newUserCode();
  const deviceCode = opaqueSecret("rdc_");
  const expiresAt = after(o, DEVICE_CODE_TTL_SECONDS);
  const row = await q.insertDeviceCode(db, { device_code: deviceCode, user_code: userCode, client_id: client.client_id, scopes, interval_seconds: DEVICE_POLL_INTERVAL_SECONDS, expires_at: expiresAt });
  const verification_uri = `${o.issuer}/activate`;
  const verification_uri_complete = `${verification_uri}?code=${encodeURIComponent(userCode)}`;
  await emit(db, o, {
    kind: "access.requested",
    actor: `bot:${client.name}`,
    summary: `${client.name} asks for access (${scopeString(scopes)}): approve ${userCode} at ${verification_uri}`,
    payload: { user_code: userCode, client_id: client.client_id, client_name: client.name, scopes, verification_uri, verification_uri_complete, expires_at: expiresAt.toISOString(), approve_api: `/api/v1/access/${encodeURIComponent(userCode)}/approve` },
    dedupe_key: `access:${userCode}:requested`,
  });
  return { device_code: deviceCode, user_code: row.user_code, verification_uri, verification_uri_complete, expires_in: DEVICE_CODE_TTL_SECONDS, interval: DEVICE_POLL_INTERVAL_SECONDS, client_id: client.client_id };
}

/** What /activate shows for a typed code; undefined when unknown. Expired pending codes are reported as such. */
export async function lookupDeviceRequest(db: Db, typed: string, o: OAuthServerOptions): Promise<(q.DeviceCodeRow & { expired: boolean }) | undefined> {
  const code = normalizeUserCode(typed);
  if (!code) return undefined;
  const d = await q.getDeviceByUserCode(db, code);
  if (!d) return undefined;
  return { ...d, expired: d.status === "pending" && isPast(o, d.expires_at) };
}

/** The one scope no credential may hand out: holding it is what makes an approver, and only a person makes approvers. */
export const APPROVER_SCOPE: TokenScope = "tokens:write";

export const isHumanActor = (actor: string): boolean => actor.startsWith("human:");

/**
 * What an actor may grant. A person signed in here (`human:<login>`: the Access page, /activate, the operator's own
 * CLI) is unrestricted. Every other actor is a credential (a bot's token over the API or MCP) and may grant only the
 * scopes it holds itself (`held`), never `tokens:write`: a bot that could approve a wider request, or mint another
 * approver, would turn one approved token into every token. Returns the refusal to throw, or undefined when allowed.
 */
export function grantCeilingError(actor: string, requested: readonly string[], held: readonly string[] | undefined, o: OAuthServerOptions, what: "approve" | "invite" = "approve"): OAuthError | undefined {
  if (isHumanActor(actor)) return undefined;
  const have = new Set(held ?? []);
  const over = requested.filter((s) => s === APPROVER_SCOPE || !have.has(s));
  if (!over.length) return undefined;
  const site = o.issuer.replace(/\/+$/, "");
  const text =
    what === "approve"
      ? `a bot can approve only scopes it holds itself, and never tokens:write; ask a person to approve this one at ${site}/activate`
      : `a bot can mint invites only for scopes it holds itself, and never tokens:write; ask a person to create this one at ${site}/tokens`;
  return new OAuthError("invalid_scope", `${text} (over the ceiling: ${over.join(", ")}).`, 403);
}

/**
 * Approve or deny from /activate, the API, a chat reply or the relay_access_approve tool. Throws OAuthError when the
 * code is not pending. `approverScopes` is what the deciding credential holds: required for every actor that is not a
 * signed-in person, since an approval may grant no more than that and never tokens:write (`grantCeilingError`); a
 * deny is always allowed.
 */
export async function decideDeviceRequest(db: Db, typed: string, decision: "approve" | "deny", actor: string, o: OAuthServerOptions, approverScopes?: readonly string[]): Promise<q.DeviceCodeRow> {
  const code = normalizeUserCode(typed);
  if (!code) throw new OAuthError("invalid_request", "That does not look like a code (RLAY-XXXX).");
  const current = await q.getDeviceByUserCode(db, code);
  if (!current) throw new OAuthError("invalid_grant", "Unknown code.");
  if (current.status !== "pending") throw new OAuthError("invalid_grant", `That request was already ${current.status}.`);
  if (isPast(o, current.expires_at)) throw new OAuthError("expired_token", "That request expired; ask the device to start again.");
  if (decision === "approve") {
    const ceiling = grantCeilingError(actor, current.scopes, approverScopes, o, "approve");
    if (ceiling) throw ceiling;
  }
  const row = await q.decideDevice(db, code, { status: decision === "approve" ? "approved" : "denied", actor, now: new Date(nowMs(o)) });
  if (!row) throw new OAuthError("invalid_grant", "That request was decided by someone else.");
  await emit(db, o, {
    kind: decision === "approve" ? "access.granted" : "access.denied",
    actor,
    summary: `${actor.replace(/^human:/, "")} ${decision === "approve" ? "approved" : "denied"} ${row.user_code} for ${row.client_name}`,
    payload: { user_code: row.user_code, client_id: row.client_id, client_name: row.client_name, scopes: row.scopes, decision },
    dedupe_key: `access:${row.user_code}:${decision}`,
  });
  return row;
}

export const listPendingAccess = (db: Db, o?: OAuthServerOptions): Promise<q.DeviceCodeRow[]> => q.listPendingDevices(db, o ? new Date(nowMs(o)) : new Date());

/** Where a device request stands, as the Access page shows it. `expired` is a pending or approved code past its time. */
export type AccessRequestState = "pending" | "approved" | "redeemed" | "denied" | "expired";

export interface AccessRequestView extends q.DeviceRequestRow {
  state: AccessRequestState;
}

export const RECENT_ACCESS_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Requests for the Access page: what needs a decision first, then approvals waiting for the poll, then the rest, each
 * newest first. It covers live codes (pending, or approved and waiting for the client to poll
 * `/oauth/token`) and every decision of the last `sinceSeconds` (default a day), each with its state and, once
 * redeemed, the name of the token it became.
 */
export async function listRecentAccess(db: Db, o?: OAuthServerOptions, sinceSeconds = RECENT_ACCESS_WINDOW_SECONDS): Promise<AccessRequestView[]> {
  const now = o ? new Date(nowMs(o)) : new Date();
  const rows = await q.listRecentDevices(db, { since: new Date(now.getTime() - sinceSeconds * 1000), now });
  const rank: Record<AccessRequestState, number> = { pending: 0, approved: 1, redeemed: 2, denied: 2, expired: 2 };
  return rows
    .map((d) => ({ ...d, state: ((d.status === "pending" || d.status === "approved") && new Date(d.expires_at).getTime() <= now.getTime() ? "expired" : d.status) as AccessRequestState }))
    .sort((a, b) => rank[a.state] - rank[b.state] || b.created_at.localeCompare(a.created_at));
}

/** Approved codes the client has not redeemed yet: what /activate shows after an approval so the person sees it took. */
export const listApprovedAwaitingPoll = async (db: Db, o?: OAuthServerOptions): Promise<AccessRequestView[]> => (await listRecentAccess(db, o)).filter((r) => r.state === "approved");

// ---------- clients (the Access page) ----------

export type { OAuthClientSummary } from "../db/oauth.ts";

/** How a client came to exist: on the fly from `POST /oauth/device` (`client_name`), through `POST /oauth/register`, or as the label for an invite's tokens. */
export type ClientOrigin = "device" | "registration" | "invite";

export function clientOrigin(c: Pick<q.OAuthClientRow, "created_by" | "grant_types" | "client_id">): ClientOrigin {
  if (c.created_by === "system:invite" || c.client_id.startsWith("rc_invite_")) return "invite";
  if (c.created_by === "anon:device") return "device";
  return "registration";
}

export const listClients = (db: Db, o?: OAuthServerOptions): Promise<q.OAuthClientSummary[]> => q.listClients(db, o ? new Date(nowMs(o)) : new Date());

/** Remove a client nothing live depends on (the guard is in `deleteClient`); writes access.client_removed. */
export async function removeClient(db: Db, clientId: string, actor: string, o?: OAuthServerOptions): Promise<q.OAuthClientRow> {
  const now = o ? new Date(nowMs(o)) : new Date();
  let row: q.OAuthClientRow | undefined;
  try {
    row = await q.deleteClient(db, clientId, now);
  } catch (e) {
    throw new OAuthError("invalid_request", e instanceof Error ? e.message : String(e));
  }
  if (!row) throw new OAuthError("invalid_client", "Unknown client_id.");
  await emit(db, o, { kind: "access.client_removed", actor, summary: `${actor.replace(/^human:/, "")} removed client ${row.name}`, payload: { client_id: row.client_id, client_name: row.name, origin: clientOrigin(row) } });
  return row;
}

// ---------- retention ----------

export type { AccessPurgeResult } from "../db/oauth.ts";

/** The retention sweep (`purgeExpiredAccess`), plus one access.purged feed row with the counts when anything went. */
export async function purgeAccess(db: Db, o?: OAuthServerOptions, actor = "bot:relay"): Promise<q.AccessPurgeResult> {
  const now = o ? new Date(nowMs(o)) : new Date();
  const r = await q.purgeExpiredAccess(db, now, GRANT_DEVICE_CODE);
  const total = r.device_codes + r.auth_codes + r.refresh_tokens + r.clients.length;
  if (total > 0) {
    const parts = [
      r.device_codes ? `${r.device_codes} device code(s)` : "",
      r.auth_codes ? `${r.auth_codes} authorization code(s)` : "",
      r.refresh_tokens ? `${r.refresh_tokens} refresh token(s)` : "",
      r.clients.length ? `${r.clients.length} orphan client(s)` : "",
    ].filter(Boolean);
    await emit(db, o, { kind: "access.purged", actor, summary: `Access retention removed ${parts.join(", ")}`, payload: { ...r } });
  }
  return r;
}

// ---------- RFC 7009 revocation ----------

/** Revoke an access token (by plaintext) or a refresh token (and its access token). Unknown tokens succeed silently. */
export async function revokeToken(db: Db, token: string, o: OAuthServerOptions): Promise<{ revoked: "access" | "refresh" | "none" }> {
  const rt = await q.getRefreshToken(db, token);
  if (rt) {
    await q.revokeRefreshToken(db, rt.token_hash);
    if (rt.access_token_id) await revokeTokenById(db, rt.access_token_id);
    await emit(db, o, { kind: "access.revoked", actor: rt.actor, summary: `Refresh token for ${rt.client_id} revoked`, payload: { client_id: rt.client_id, token_id: rt.access_token_id } });
    return { revoked: "refresh" };
  }
  const row = await revokeTokenByHash(db, hashToken(token));
  if (row) {
    await emit(db, o, { kind: "access.revoked", actor: row.created_by, summary: `Token ${row.name} revoked`, payload: { token_id: row.id, client_id: row.client_id } });
    return { revoked: "access" };
  }
  return { revoked: "none" };
}

// ---------- invites ----------

export interface CreateInviteInput {
  /** Who it is for; the token will be `oauth:<name>`. */
  name: string;
  scopes: string[];
  /** Seconds until the code stops working (default 24 h). */
  expiresInSeconds?: number;
  uses?: number;
  createdBy: string;
  /** What `createdBy` holds when it is a credential rather than a signed-in person: the invite may carry no more, and never tokens:write. */
  creatorScopes?: readonly string[];
}

/** `relay invite create`: the code is in the result and nowhere else. */
export async function createInvite(db: Db, input: CreateInviteInput, o: OAuthServerOptions): Promise<{ code: string; invite: q.InviteRow }> {
  const name = input.name.trim();
  if (!name) throw new OAuthError("invalid_request", "name is required.");
  if (name.length > 80) throw new OAuthError("invalid_request", "name must be at most 80 characters.");
  const scopes = resolveScopes(input.scopes, null, []);
  if (!scopes.length) throw new OAuthError("invalid_scope", "An invite needs at least one scope.");
  const ceiling = grantCeilingError(input.createdBy, scopes, input.creatorScopes, o, "invite");
  if (ceiling) throw ceiling;
  const uses = input.uses ?? 1;
  if (!Number.isInteger(uses) || uses < 1 || uses > 1000) throw new OAuthError("invalid_request", "uses must be between 1 and 1000.");
  const ttl = input.expiresInSeconds ?? INVITE_DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 365 * 86_400) throw new OAuthError("invalid_request", "expires must be between 1 second and 365 days.");
  const code = opaqueSecret("rin_", 24);
  const invite = await q.insertInvite(db, { code, name, scopes, uses, expires_at: after(o, ttl), created_by: input.createdBy });
  await emit(db, o, { kind: "access.invite_created", actor: input.createdBy, summary: `${input.createdBy.replace(/^human:/, "")} created invite ${invite.id} for ${name} (${scopeString(scopes)}; ${uses} use(s))`, payload: { invite_id: invite.id, name, scopes, uses, expires_at: invite.expires_at } });
  return { code, invite };
}

export const listInvites = (db: Db, opts?: { includeSpent?: boolean; now?: Date }): Promise<q.InviteRow[]> => q.listInvites(db, opts);

/** Stop an unredeemed invite by id or name; writes access.invite_revoked. Undefined when nothing live matched. */
export async function revokeInvite(db: Db, idOrName: string, actor?: string, o?: OAuthServerOptions): Promise<q.InviteRow | undefined> {
  const row = await q.revokeInvite(db, idOrName);
  if (row) await emit(db, o, { kind: "access.invite_revoked", actor: actor ?? row.created_by, summary: `Invite ${row.id} for ${row.name} revoked (${row.uses_left} use(s) left)`, payload: { invite_id: row.id, name: row.name, uses_left: row.uses_left } });
  return row;
}
