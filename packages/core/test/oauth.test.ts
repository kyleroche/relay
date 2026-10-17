import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, type Db } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import * as repo from "../src/db/repo.ts";
import { findToken, TOKEN_SCOPES } from "../src/db/tokens.ts";
import { getSetting, openValue, putSetting, sealValue } from "../src/db/settings.ts";
import { newUserCode, normalizeUserCode, parseDuration, pkceChallenge, pkceVerifier, redirectUriMatches, validRedirectUri, verifyPkce } from "../src/oauth/codes.ts";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  authorizationServerMetadata,
  createInvite,
  decideDeviceRequest,
  denyAuthorization,
  deviceAuthorization,
  DEVICE_CODE_TTL_SECONDS,
  exchangeToken,
  GRANT_DEVICE_CODE,
  GRANT_INVITE,
  grantCeilingError,
  issueAuthorizationCode,
  listApprovedAwaitingPoll,
  listClients,
  listInvites,
  listPendingAccess,
  listRecentAccess,
  lookupDeviceRequest,
  clientOrigin,
  purgeAccess,
  removeClient,
  revokeInvite,
  OAuthError,
  protectedResourceMetadata,
  registerClient,
  REFRESH_TOKEN_TTL_SECONDS,
  revokeToken,
  validateAuthorizeRequest,
  type OAuthServerOptions,
} from "../src/oauth/server.ts";
import { credentialsFromToken, deviceFlow, redeemInvite, refreshAccessToken, tokenIsStale } from "../src/client/device.ts";
import type { HttpFetch } from "../src/client/http.ts";

let db: Db;
let clock = Date.parse("2026-10-16T10:00:00.000Z");
const events: repo.EventRow[] = [];
const o: OAuthServerOptions = { issuer: "https://relay.test", now: () => clock, onEvent: (row) => void events.push(row) };
const tick = (seconds: number) => (clock += seconds * 1000);

beforeAll(async () => {
  db = await openDb({ file: ":memory:" });
  await migrate(db);
});
afterAll(async () => {
  await db.close();
});

const fails = async (p: Promise<unknown>, code: string): Promise<OAuthError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OAuthError);
    expect((e as OAuthError).code).toBe(code);
    return e as OAuthError;
  }
  throw new Error(`expected ${code}`);
};

describe("pure helpers", () => {
  it("PKCE S256 verifies the matching verifier only", () => {
    const v = pkceVerifier();
    expect(v.length).toBe(43);
    const c = pkceChallenge(v);
    expect(verifyPkce(v, c)).toBe(true);
    expect(verifyPkce(v + "x", c)).toBe(false);
    expect(verifyPkce("short", pkceChallenge("short"))).toBe(false);
    expect(verifyPkce(v, c, "plain")).toBe(false);
  });
  it("user codes read aloud and normalise from what people type", () => {
    const code = newUserCode();
    expect(code).toMatch(/^RLAY-[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/);
    expect(normalizeUserCode(" rlay 4f7q ")).toBe("RLAY-4F7Q");
    expect(normalizeUserCode("4F7Q")).toBe("RLAY-4F7Q");
    expect(normalizeUserCode("RLAY-4f-7q")).toBe("RLAY-4F7Q");
    expect(normalizeUserCode("nope!")).toBeUndefined();
    expect(normalizeUserCode("")).toBeUndefined();
  });
  it("parses durations and redirect URIs the documented way", () => {
    expect(parseDuration("24h")).toBe(86_400);
    expect(parseDuration("30m")).toBe(1800);
    expect(parseDuration("7d")).toBe(604_800);
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("soon")).toBeUndefined();
    expect(validRedirectUri("https://bot.example/cb")).toBe(true);
    expect(validRedirectUri("http://localhost:4123/cb")).toBe(true);
    expect(validRedirectUri("http://bot.example/cb")).toBe(false);
    expect(validRedirectUri("myapp://callback")).toBe(true);
    expect(validRedirectUri("javascript:alert(1)")).toBe(false);
    expect(redirectUriMatches("http://localhost/cb", "http://localhost:51234/cb")).toBe(true);
    expect(redirectUriMatches("https://a.example/cb", "https://a.example/cb2")).toBe(false);
  });
  it("publishes RFC 8414 and RFC 9728 metadata that point at each other", () => {
    const m = authorizationServerMetadata("https://relay.test/");
    expect(m.issuer).toBe("https://relay.test");
    expect(m.token_endpoint).toBe("https://relay.test/oauth/token");
    expect(m.device_authorization_endpoint).toBe("https://relay.test/oauth/device");
    expect(m.scopes_supported).toEqual([...TOKEN_SCOPES]);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.grant_types_supported).toContain(GRANT_DEVICE_CODE);
    expect(m.grant_types_supported).toContain(GRANT_INVITE);
    const r = protectedResourceMetadata("https://relay.test");
    expect(r.authorization_servers).toEqual(["https://relay.test"]);
  });
});

describe("authorization code with PKCE", () => {
  it("registers a public client, issues a code on consent, exchanges it once, then refreshes with rotation", async () => {
    const reg = await registerClient(db, { client_name: "Grok Bot", redirect_uris: ["https://grok.example/oauth/callback"], grant_types: ["authorization_code", "refresh_token"] }, o);
    expect(reg.client_id).toMatch(/^rc_/);
    expect(reg.client_secret).toBeUndefined();
    expect(reg.token_endpoint_auth_method).toBe("none");

    const verifier = pkceVerifier();
    const params = { response_type: "code", client_id: reg.client_id, redirect_uri: "https://grok.example/oauth/callback", scope: "tasks:read tasks:write events:write", state: "xyz", code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", resource: "https://relay.test/mcp" };
    const v = await validateAuthorizeRequest(db, params, o);
    expect("request" in v).toBe(true);
    if (!("request" in v)) throw new Error("unreachable");
    expect(v.request.scopes).toEqual(["tasks:read", "tasks:write", "events:write"]);
    expect(v.request.client.name).toBe("Grok Bot");

    // deny goes back with access_denied and the state
    const denied = new URL(denyAuthorization(v.request));
    expect(denied.searchParams.get("error")).toBe("access_denied");
    expect(denied.searchParams.get("state")).toBe("xyz");

    const redirect = new URL(await issueAuthorizationCode(db, v.request, "human:kyle", o));
    expect(redirect.origin + redirect.pathname).toBe("https://grok.example/oauth/callback");
    expect(redirect.searchParams.get("state")).toBe("xyz");
    expect(redirect.searchParams.get("iss")).toBe("https://relay.test");
    const code = redirect.searchParams.get("code")!;
    expect(code).toMatch(/^rac_/);

    // wrong verifier: refused, and the code is spent (OAuth 2.1 single use)
    await fails(exchangeToken(db, { grant_type: "authorization_code", client_id: reg.client_id, code, redirect_uri: params.redirect_uri, code_verifier: pkceVerifier() }, o), "invalid_grant");
    await fails(exchangeToken(db, { grant_type: "authorization_code", client_id: reg.client_id, code, redirect_uri: params.redirect_uri, code_verifier: verifier }, o), "invalid_grant");

    // a fresh code with the right verifier
    const redirect2 = new URL(await issueAuthorizationCode(db, v.request, "human:kyle", o));
    const t = await exchangeToken(db, { grant_type: "authorization_code", client_id: reg.client_id, code: redirect2.searchParams.get("code"), redirect_uri: params.redirect_uri, code_verifier: verifier, resource: "https://relay.test/mcp" }, o);
    expect(t.token_type).toBe("Bearer");
    expect(t.expires_in).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(t.scope).toBe("tasks:read tasks:write events:write");
    expect(t.token_name).toBe("oauth:Grok Bot");
    expect(t.access_token).toMatch(/^rly_/);
    expect(t.refresh_token).toMatch(/^rrt_/);

    // the access token is an ordinary tokens row, so every existing check sees it
    const row = await findToken(db, t.access_token);
    expect(row?.name).toBe("oauth:Grok Bot");
    expect(row?.scopes).toEqual(["tasks:read", "tasks:write", "events:write"]);
    expect(row?.client_id).toBe(reg.client_id);
    expect(row?.expires_at).toBe(new Date(clock + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString());
    expect(events.some((e) => e.kind === "access.granted" && e.actor === "human:kyle")).toBe(true);

    // refresh: new pair, old access token dead, old refresh token dead; reuse revokes the lineage
    const t2 = await exchangeToken(db, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: reg.client_id }, o);
    expect(t2.access_token).not.toBe(t.access_token);
    expect(t2.refresh_token).not.toBe(t.refresh_token);
    expect(await findToken(db, t.access_token)).toBeUndefined();
    expect((await findToken(db, t2.access_token))?.name).toBe("oauth:Grok Bot");
    // narrowing is allowed, widening is not
    await fails(exchangeToken(db, { grant_type: "refresh_token", refresh_token: t2.refresh_token, scope: "tasks:read memory:write" }, o), "invalid_scope");
    const t3 = await exchangeToken(db, { grant_type: "refresh_token", refresh_token: t2.refresh_token, scope: "tasks:read" }, o);
    expect(t3.scope).toBe("tasks:read");
    // replaying t2's refresh token cuts t3 too
    const e = await fails(exchangeToken(db, { grant_type: "refresh_token", refresh_token: t2.refresh_token }, o), "invalid_grant");
    expect(e.description).toMatch(/already used/);
    expect(await findToken(db, t3.access_token)).toBeUndefined();
    await fails(exchangeToken(db, { grant_type: "refresh_token", refresh_token: t3.refresh_token }, o), "invalid_grant");
  });

  it("refuses bad clients and redirect URIs without redirecting, and sends client-visible errors back to the registered URI", async () => {
    await fails(validateAuthorizeRequest(db, { client_id: "rc_nope", redirect_uri: "https://x.example/cb", response_type: "code" }, o), "invalid_client");
    const reg = await registerClient(db, { client_name: "Other", redirect_uris: ["https://other.example/cb"] }, o);
    await fails(validateAuthorizeRequest(db, { client_id: reg.client_id, redirect_uri: "https://evil.example/cb", response_type: "code" }, o), "invalid_redirect_uri");
    const noPkce = await validateAuthorizeRequest(db, { client_id: reg.client_id, redirect_uri: "https://other.example/cb", response_type: "code", state: "s" }, o);
    expect("redirectError" in noPkce && new URL(noPkce.redirectError).searchParams.get("error")).toBe("invalid_request");
    const badScope = await validateAuthorizeRequest(db, { client_id: reg.client_id, redirect_uri: "https://other.example/cb", response_type: "code", code_challenge: pkceChallenge(pkceVerifier()), scope: "root:all" }, o);
    expect("redirectError" in badScope && new URL(badScope.redirectError).searchParams.get("error")).toBe("invalid_scope");
    const badResource = await validateAuthorizeRequest(db, { client_id: reg.client_id, redirect_uri: "https://other.example/cb", response_type: "code", code_challenge: pkceChallenge(pkceVerifier()), resource: "https://elsewhere.example" }, o);
    expect("redirectError" in badResource && new URL(badResource.redirectError).searchParams.get("error")).toBe("invalid_target");
    await fails(registerClient(db, { client_name: "x", redirect_uris: ["http://bot.example/cb"] }, o), "invalid_redirect_uri");
    await fails(registerClient(db, { redirect_uris: ["https://bot.example/cb"] }, o), "invalid_client_metadata");
  });

  it("confidential clients must present their secret", async () => {
    const reg = await registerClient(db, { client_name: "Server bot", redirect_uris: ["https://srv.example/cb"], token_endpoint_auth_method: "client_secret_post" }, o);
    expect(reg.client_secret).toMatch(/^rcs_/);
    const verifier = pkceVerifier();
    const v = await validateAuthorizeRequest(db, { client_id: reg.client_id, redirect_uri: "https://srv.example/cb", response_type: "code", code_challenge: pkceChallenge(verifier), scope: "feed:read" }, o);
    if (!("request" in v)) throw new Error("unreachable");
    const code = new URL(await issueAuthorizationCode(db, v.request, "human:kyle", o)).searchParams.get("code");
    await fails(exchangeToken(db, { grant_type: "authorization_code", client_id: reg.client_id, code, code_verifier: verifier }, o), "invalid_client");
    const code2 = new URL(await issueAuthorizationCode(db, v.request, "human:kyle", o)).searchParams.get("code");
    const t = await exchangeToken(db, { grant_type: "authorization_code", client_id: reg.client_id, client_secret: reg.client_secret, code: code2, code_verifier: verifier }, o);
    expect(t.scope).toBe("feed:read");
  });
});

describe("device flow", () => {
  it("approve: pending → slow_down → approved → token, redeemable once; feed carries access.requested", async () => {
    events.length = 0;
    const d = await deviceAuthorization(db, { client_name: "relay-cli@studio", scope: "feed:read memory:read memory:write" }, o);
    expect(d.user_code).toMatch(/^RLAY-/);
    expect(d.device_code).toMatch(/^rdc_/);
    expect(d.verification_uri).toBe("https://relay.test/activate");
    expect(d.verification_uri_complete).toBe(`https://relay.test/activate?code=${d.user_code}`);
    expect(d.interval).toBe(5);
    const requested = events.find((e) => e.kind === "access.requested");
    expect(requested?.summary).toContain(d.user_code);
    expect(requested?.payload.approve_api).toBe(`/api/v1/access/${d.user_code}/approve`);
    expect((await listPendingAccess(db, o)).map((p) => p.user_code)).toContain(d.user_code);

    const poll = () => exchangeToken(db, { grant_type: GRANT_DEVICE_CODE, device_code: d.device_code, client_id: d.client_id }, o);
    await fails(poll(), "authorization_pending");
    tick(1);
    await fails(poll(), "slow_down");
    tick(6);
    await fails(poll(), "authorization_pending");

    const shown = await lookupDeviceRequest(db, d.user_code.toLowerCase(), o);
    expect(shown?.client_name).toBe("relay-cli@studio");
    expect(shown?.scopes).toEqual(["feed:read", "memory:read", "memory:write"]);
    expect(shown?.expired).toBe(false);

    const row = await decideDeviceRequest(db, d.user_code, "approve", "human:kyle", o);
    expect(row.status).toBe("approved");
    await fails(decideDeviceRequest(db, d.user_code, "approve", "human:kyle", o), "invalid_grant");
    tick(6);
    const t = await poll();
    expect(t.token_name).toBe("oauth:relay-cli@studio");
    expect(t.scope).toBe("feed:read memory:read memory:write");
    expect((await findToken(db, t.access_token))?.created_by).toBe("human:kyle");
    tick(6);
    await fails(poll(), "invalid_grant");
    expect((await listPendingAccess(db, o)).map((p) => p.user_code)).not.toContain(d.user_code);
  });

  it("deny: the poll ends with access_denied", async () => {
    const d = await deviceAuthorization(db, { client_name: "stranger", scope: "tokens:write" }, o);
    await decideDeviceRequest(db, d.user_code, "deny", "human:kyle", o);
    tick(6);
    await fails(exchangeToken(db, { grant_type: GRANT_DEVICE_CODE, device_code: d.device_code }, o), "access_denied");
    expect(events.some((e) => e.kind === "access.denied" && e.summary.includes(d.user_code))).toBe(true);
  });

  it("expiry: an unapproved code expires for the poller and for the approver", async () => {
    const d = await deviceAuthorization(db, { client_name: "late", scope: "feed:read" }, o);
    tick(DEVICE_CODE_TTL_SECONDS + 1);
    await fails(exchangeToken(db, { grant_type: GRANT_DEVICE_CODE, device_code: d.device_code }, o), "expired_token");
    await fails(decideDeviceRequest(db, d.user_code, "approve", "human:kyle", o), "expired_token");
    expect((await lookupDeviceRequest(db, d.user_code, o))?.expired).toBe(true);
  });

  it("the CLI's deviceFlow drives the same endpoints over HTTP", async () => {
    // a fetch that routes the two endpoints to the server functions
    const fetchImpl: HttpFetch = async (url, init) => {
      const u = new URL(url);
      const body = Object.fromEntries(new URLSearchParams(init.body ?? ""));
      const json = (status: number, v: unknown) => ({ ok: status < 400, status, headers: { get: () => "application/json" }, text: async () => JSON.stringify(v) });
      try {
        if (u.pathname === "/oauth/device") return json(200, await deviceAuthorization(db, body, o));
        if (u.pathname === "/oauth/token") return json(200, await exchangeToken(db, body, o));
        return json(404, {});
      } catch (e) {
        if (e instanceof OAuthError) return json(e.status, e.toJSON());
        throw e;
      }
    };
    let prompt: { user_code: string } | undefined;
    const run = deviceFlow({
      site: "https://relay.test/",
      clientName: "relay-cli@laptop",
      scopes: ["feed:read"],
      fetch: fetchImpl,
      onPrompt: (p) => {
        prompt = p;
      },
      sleep: async (ms) => {
        tick(ms / 1000);
        if (prompt) await decideDeviceRequest(db, prompt.user_code, "approve", "human:kyle", o).catch(() => undefined);
      },
      now: () => clock,
    });
    const t = await run;
    expect(prompt?.user_code).toMatch(/^RLAY-/);
    expect(t.token_name).toBe("oauth:relay-cli@laptop");
    const creds = credentialsFromToken(t, clock);
    expect(creds.refreshToken).toMatch(/^rrt_/);
    expect(tokenIsStale(creds.expiresAt, clock)).toBe(false);
    expect(tokenIsStale(creds.expiresAt, clock + ACCESS_TOKEN_TTL_SECONDS * 1000)).toBe(true);
    const t2 = await refreshAccessToken({ site: "https://relay.test", refreshToken: t.refresh_token!, fetch: fetchImpl });
    expect(t2.access_token).not.toBe(t.access_token);
  });
});

describe("invites", () => {
  it("a single-use invite redeems once for a token named after it, then is spent", async () => {
    const { code, invite } = await createInvite(db, { name: "woodhouse", scopes: ["tasks:read", "tasks:write", "events:write"], expiresInSeconds: 3600, createdBy: "human:kyle" }, o);
    expect(code).toMatch(/^rin_/);
    expect(invite.uses_left).toBe(1);
    const t = await exchangeToken(db, { grant_type: GRANT_INVITE, invite: code, client_name: "woodhouse@mini" }, o);
    expect(t.token_name).toBe("oauth:woodhouse");
    expect(t.scope).toBe("tasks:read tasks:write events:write");
    const row = await findToken(db, t.access_token);
    expect(row?.created_by).toBe(`invite:${invite.id}`);
    const e = await fails(exchangeToken(db, { grant_type: GRANT_INVITE, invite: code }, o), "invalid_grant");
    expect(e.description).toMatch(/no uses left/);
    await fails(exchangeToken(db, { grant_type: GRANT_INVITE, invite: "rin_nope" }, o), "invalid_grant");
    // the refresh token works like any other
    const t2 = await exchangeToken(db, { grant_type: "refresh_token", refresh_token: t.refresh_token }, o);
    expect(t2.token_name).toBe("oauth:woodhouse");
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(90 * 86_400);
  });

  it("multi-use, expiry and revocation", async () => {
    const two = await createInvite(db, { name: "runner", scopes: ["feed:read"], uses: 2, expiresInSeconds: 60, createdBy: "human:kyle" }, o);
    await exchangeToken(db, { grant_type: GRANT_INVITE, invite: two.code }, o);
    tick(61);
    const e = await fails(exchangeToken(db, { grant_type: GRANT_INVITE, invite: two.code }, o), "invalid_grant");
    expect(e.description).toMatch(/expired/);
    const r = await createInvite(db, { name: "revoked", scopes: ["feed:read"], createdBy: "human:kyle" }, o);
    expect(await repo.revokeInvite(db, "revoked")).toBeDefined();
    const e2 = await fails(exchangeToken(db, { grant_type: GRANT_INVITE, invite: r.code }, o), "invalid_grant");
    expect(e2.description).toMatch(/revoked/);
    await fails(createInvite(db, { name: "x", scopes: [], createdBy: "human:kyle" }, o), "invalid_scope");
    const redeemed = await redeemInvite({
      site: "https://relay.test",
      code: (await createInvite(db, { name: "cli-invite", scopes: ["feed:read"], createdBy: "human:kyle" }, o)).code,
      clientName: "relay-cli",
      fetch: async (_u, init) => {
        const body = Object.fromEntries(new URLSearchParams(init.body ?? ""));
        const v = await exchangeToken(db, body, o);
        return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify(v) };
      },
    });
    expect(redeemed.token_name).toBe("oauth:cli-invite");
  });
});

describe("revocation", () => {
  it("revokes access tokens by plaintext and refresh tokens with their access token", async () => {
    const i = await createInvite(db, { name: "rev", scopes: ["feed:read"], createdBy: "human:kyle" }, o);
    const t = await exchangeToken(db, { grant_type: GRANT_INVITE, invite: i.code }, o);
    expect((await revokeToken(db, t.access_token, o)).revoked).toBe("access");
    expect(await findToken(db, t.access_token)).toBeUndefined();
    const t2 = await exchangeToken(db, { grant_type: "refresh_token", refresh_token: t.refresh_token }, o);
    expect((await revokeToken(db, t2.refresh_token, o)).revoked).toBe("refresh");
    expect(await findToken(db, t2.access_token)).toBeUndefined();
    await fails(exchangeToken(db, { grant_type: "refresh_token", refresh_token: t2.refresh_token }, o), "invalid_grant");
    expect((await revokeToken(db, "rly_unknown", o)).revoked).toBe("none");
  });

  it("expired access tokens are not found", async () => {
    const i = await createInvite(db, { name: "exp", scopes: ["feed:read"], createdBy: "human:kyle" }, o);
    const t = await exchangeToken(db, { grant_type: GRANT_INVITE, invite: i.code }, o);
    expect(await findToken(db, t.access_token)).toBeDefined();
    // findToken uses the database clock; move the row's expiry into the past instead of the test clock
    await db.query("UPDATE tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [repo.hashToken(t.access_token)]);
    expect(await findToken(db, t.access_token)).toBeUndefined();
  });
});

describe("sealed settings", () => {
  it("seal and open round-trip under one secret and fail under another", async () => {
    const sealed = sealValue("-----BEGIN RSA PRIVATE KEY-----\nabc\n", "s3cret-s3cret-s3cret");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(openValue(sealed, "s3cret-s3cret-s3cret")).toBe("-----BEGIN RSA PRIVATE KEY-----\nabc\n");
    expect(openValue(sealed, "another-secret-value")).toBeUndefined();
    expect(openValue("v1.garbage", "s3cret-s3cret-s3cret")).toBeUndefined();
    await putSetting(db, "github_app.id", "12345");
    await putSetting(db, "github_app.private_key", "pem", { secret: "s3cret-s3cret-s3cret" });
    expect(await getSetting(db, "github_app.id")).toBe("12345");
    expect(await getSetting(db, "github_app.private_key", { secret: "s3cret-s3cret-s3cret" })).toBe("pem");
    expect(await getSetting(db, "github_app.private_key", { secret: "wrong-secret-value" })).toBeUndefined();
    expect(await getSetting(db, "github_app.private_key")).toBeUndefined();
  });
});

describe("the Access page and retention", () => {
  const scope = "feed:read";
  it("listRecentAccess tells pending, approved-awaiting-poll, redeemed (with the token's name), denied and expired apart", async () => {
    const expired = await deviceAuthorization(db, { client_name: "late-bot", scope }, o);
    tick(DEVICE_CODE_TTL_SECONDS + 1);
    const pending = await deviceAuthorization(db, { client_name: "pending-bot", scope }, o);
    const approved = await deviceAuthorization(db, { client_name: "woodhouse", scope }, o);
    const redeemed = await deviceAuthorization(db, { client_name: "redeemed-bot", scope }, o);
    const denied = await deviceAuthorization(db, { client_name: "denied-bot", scope }, o);
    await decideDeviceRequest(db, approved.user_code, "approve", "human:kyle", o);
    await decideDeviceRequest(db, redeemed.user_code, "approve", "human:kyle", o);
    await decideDeviceRequest(db, denied.user_code, "deny", "human:kyle", o);
    const t = await exchangeToken(db, { grant_type: GRANT_DEVICE_CODE, device_code: redeemed.device_code, client_id: redeemed.client_id }, o);

    const rows = await listRecentAccess(db, o);
    const by = (code: string) => rows.find((r) => r.user_code === code);
    expect(by(expired.user_code)?.state).toBe("expired");
    expect(by(pending.user_code)?.state).toBe("pending");
    expect(by(approved.user_code)?.state).toBe("approved");
    expect(by(approved.user_code)?.token_name).toBeNull();
    expect(by(redeemed.user_code)?.state).toBe("redeemed");
    expect(by(redeemed.user_code)?.token_name).toBe(t.token_name);
    expect(by(denied.user_code)?.state).toBe("denied");
    expect(rows.findIndex((r) => r.user_code === denied.user_code)).toBeLessThan(rows.findIndex((r) => r.user_code === expired.user_code));
    expect((await listApprovedAwaitingPoll(db, o)).map((r) => r.client_name)).toEqual(["woodhouse"]);
    expect((await listPendingAccess(db, o)).map((r) => r.user_code)).toEqual([pending.user_code]);
  });

  it("listClients counts what is live and names how each client was registered", async () => {
    const clients = await listClients(db, o);
    const named = (n: string) => clients.find((c) => c.name === n)!;
    expect(named("redeemed-bot")).toMatchObject({ live_tokens: 1, pending_codes: 0, live_refresh_tokens: 1 });
    expect(named("woodhouse")).toMatchObject({ live_tokens: 0, pending_codes: 1, live_refresh_tokens: 0 });
    expect(named("pending-bot").pending_codes).toBe(1);
    expect(named("late-bot")).toMatchObject({ live_tokens: 0, pending_codes: 0, live_refresh_tokens: 0 });
    expect(clientOrigin(named("late-bot"))).toBe("device");
    const dcr = await registerClient(db, { client_name: "dcr-app", redirect_uris: ["https://app.example/cb"] }, o);
    expect(clientOrigin((await listClients(db, o)).find((c) => c.client_id === dcr.client_id)!)).toBe("registration");
    expect(clientOrigin(clients.find((c) => c.name === "woodhouse@mini" || c.client_id.startsWith("rc_invite_"))!)).toBe("invite");
  });

  it("removeClient refuses while a token, code or refresh token is live, then removes with its codes", async () => {
    const clients = await listClients(db, o);
    const redeemed = clients.find((c) => c.name === "redeemed-bot")!;
    const e = await fails(removeClient(db, redeemed.client_id, "human:kyle", o), "invalid_request");
    expect(e.description).toMatch(/1 live token/);
    const approved = clients.find((c) => c.name === "woodhouse")!;
    await fails(removeClient(db, approved.client_id, "human:kyle", o), "invalid_request");
    await fails(removeClient(db, "rc_unknown", "human:kyle", o), "invalid_client");

    const live = await repo.listTokens(db);
    const tok = live.find((t) => t.client_id === redeemed.client_id)!;
    const rt = await db.query<{ token_hash: string }>("SELECT token_hash FROM oauth_refresh_tokens WHERE client_id = $1", [redeemed.client_id]);
    await repo.revokeRefreshToken(db, rt[0]!.token_hash);
    await repo.revokeTokenById(db, tok.id);
    events.length = 0;
    const gone = await removeClient(db, redeemed.client_id, "human:kyle", o);
    expect(gone.name).toBe("redeemed-bot");
    expect(await repo.getClient(db, redeemed.client_id)).toBeUndefined();
    expect((await db.query("SELECT 1 FROM oauth_device_codes WHERE client_id = $1", [redeemed.client_id])).length).toBe(0);
    expect((await db.query("SELECT 1 FROM oauth_refresh_tokens WHERE client_id = $1", [redeemed.client_id])).length).toBe(0);
    expect((await repo.getTokenById(db, tok.id))?.client_id).toBe(redeemed.client_id);
    expect(events.map((x) => x.kind)).toEqual(["access.client_removed"]);
  });

  it("invites write access.invite_created and access.invite_revoked", async () => {
    events.length = 0;
    const { invite } = await createInvite(db, { name: "audited", scopes: ["feed:read"], createdBy: "human:kyle" }, o);
    expect(events.map((x) => x.kind)).toEqual(["access.invite_created"]);
    expect(events[0]!.payload.invite_id).toBe(invite.id);
    expect(await revokeInvite(db, invite.id, "human:kyle", o)).toBeDefined();
    expect(events.map((x) => x.kind)).toEqual(["access.invite_created", "access.invite_revoked"]);
    expect(await revokeInvite(db, invite.id, "human:kyle", o)).toBeUndefined();
    expect(events.length).toBe(2);
  });

  it("purgeAccess removes day-old expired codes and orphan device clients, keeps everything live, and logs once", async () => {
    const smoke = await deviceAuthorization(db, { client_name: "relay-smoke-test", scope }, o);
    const dcr = await registerClient(db, { client_name: "kept-dcr", redirect_uris: ["https://app.example/cb"] }, o);
    const fresh = await deviceAuthorization(db, { client_name: "fresh-bot", scope }, o);
    const dayAgo = new Date(clock - 2 * 86_400_000);
    // created_at defaults to the database clock; pin the two old clients to the test clock
    await db.query("UPDATE oauth_clients SET created_at = $2 WHERE client_id = ANY($1::text[])", [[smoke.client_id, dcr.client_id], dayAgo]);

    events.length = 0;
    const before = await purgeAccess(db, o);
    expect(before).toEqual({ device_codes: 0, auth_codes: 0, refresh_tokens: 0, clients: [] });
    expect(events.length).toBe(0);

    tick(DEVICE_CODE_TTL_SECONDS + 86_400 + 1);
    const r = await purgeAccess(db, o);
    expect(r.device_codes).toBeGreaterThan(0);
    expect(r.clients).toContain("relay-smoke-test");
    expect(r.clients).not.toContain("kept-dcr");
    expect(r.clients).not.toContain("fresh-bot");
    expect(r.clients).not.toContain("woodhouse");
    expect(await repo.getClient(db, smoke.client_id)).toBeUndefined();
    expect(await repo.getClient(db, fresh.client_id)).toBeDefined();
    expect((await db.query("SELECT 1 FROM oauth_device_codes WHERE client_id = $1", [fresh.client_id])).length).toBe(0);
    expect(events.map((x) => x.kind)).toEqual(["access.purged"]);
    expect(events[0]!.payload.clients).toContain("relay-smoke-test");

    // fresh-bot is now a day older than its (deleted) code and nothing else refers to it: the next sweep takes it
    await db.query("UPDATE oauth_clients SET created_at = $2 WHERE client_id = $1", [fresh.client_id, new Date(clock - 2 * 86_400_000)]);
    expect((await purgeAccess(db, o)).clients).toEqual(["fresh-bot"]);

    // refresh tokens go 30 days after they expire, not before
    expect((await purgeAccess(db, o)).refresh_tokens).toBe(0);
    tick(REFRESH_TOKEN_TTL_SECONDS + 30 * 86_400 + 1);
    const late = await purgeAccess(db, o);
    expect(late.refresh_tokens).toBeGreaterThan(0);
    expect((await db.query("SELECT 1 FROM oauth_refresh_tokens")).length).toBe(0);
  });
});

describe("the grant ceiling: a bot never grants more than it holds, and never tokens:write", () => {
  // Its own database: the Access page tests above count what is live in the shared one.
  let cdb: Db;
  const held = ["tasks:read", "tasks:write", "events:write", "tokens:write"];
  beforeAll(async () => {
    cdb = await openDb({ file: ":memory:" });
    await migrate(cdb);
  });
  afterAll(async () => {
    await cdb.close();
  });

  it("approvals: wider than held and tokens:write are refused, the subset passes, deny is always allowed, a person is unrestricted", async () => {
    const wide = await deviceAuthorization(cdb, { client_name: "wide", scope: "tasks:read memory:write" }, o);
    const e1 = await fails(decideDeviceRequest(cdb, wide.user_code, "approve", "bot:oauth:woodhouse", o, held), "invalid_scope");
    expect(e1.status).toBe(403);
    expect(e1.description).toContain("a bot can approve only scopes it holds itself, and never tokens:write; ask a person to approve this one at https://relay.test/activate");
    expect(e1.description).toContain("memory:write");
    expect((await lookupDeviceRequest(cdb, wide.user_code, o))?.status).toBe("pending");

    const approver = await deviceAuthorization(cdb, { client_name: "would-be-approver", scope: "tasks:read tokens:write" }, o);
    const e2 = await fails(decideDeviceRequest(cdb, approver.user_code, "approve", "bot:oauth:woodhouse", o, held), "invalid_scope");
    expect(e2.description).toContain("over the ceiling: tokens:write");

    // a credential whose scopes are not passed holds nothing
    const subset = await deviceAuthorization(cdb, { client_name: "newcomer", scope: "tasks:read tasks:write" }, o);
    await fails(decideDeviceRequest(cdb, subset.user_code, "approve", "token:ci", o), "invalid_scope");
    expect(grantCeilingError("token:ci", ["tasks:read"], undefined, o)?.status).toBe(403);
    expect(grantCeilingError("bot:x", ["tasks:read"], ["tasks:read"], o)).toBeUndefined();
    expect(grantCeilingError("human:kyle", ["tokens:write"], undefined, o)).toBeUndefined();

    expect((await decideDeviceRequest(cdb, wide.user_code, "deny", "bot:oauth:woodhouse", o, held)).status).toBe("denied");
    const ok = await decideDeviceRequest(cdb, subset.user_code, "approve", "bot:oauth:woodhouse", o, held);
    expect(ok.status).toBe("approved");
    expect(ok.actor).toBe("bot:oauth:woodhouse");
    expect((await exchangeToken(cdb, { grant_type: GRANT_DEVICE_CODE, device_code: subset.device_code, client_id: subset.client_id }, o)).scope).toBe("tasks:read tasks:write");

    expect((await decideDeviceRequest(cdb, approver.user_code, "approve", "human:kyle", o)).status).toBe("approved");
  });

  it("invites: the same ceiling on what the code will grant", async () => {
    const e = await fails(createInvite(cdb, { name: "too-wide", scopes: ["tasks:read", "feed:read"], createdBy: "bot:oauth:woodhouse", creatorScopes: held }, o), "invalid_scope");
    expect(e.status).toBe(403);
    expect(e.description).toContain("a bot can mint invites only for scopes it holds itself, and never tokens:write; ask a person to create this one at https://relay.test/tokens");
    expect(e.description).toContain("feed:read");
    await fails(createInvite(cdb, { name: "approver", scopes: ["tokens:write"], createdBy: "bot:oauth:woodhouse", creatorScopes: held }, o), "invalid_scope");
    await fails(createInvite(cdb, { name: "unknown-holdings", scopes: ["tasks:read"], createdBy: "token:ci" }, o), "invalid_scope");
    expect((await listInvites(cdb)).length).toBe(0);

    const ok = await createInvite(cdb, { name: "within", scopes: ["tasks:read", "tasks:write"], createdBy: "bot:oauth:woodhouse", creatorScopes: held }, o);
    expect(ok.invite.scopes).toEqual(["tasks:read", "tasks:write"]);
    expect((await exchangeToken(cdb, { grant_type: GRANT_INVITE, invite: ok.code }, o)).token_name).toBe("oauth:within");
    expect((await createInvite(cdb, { name: "by-a-person", scopes: ["tokens:write"], createdBy: "human:kyle" }, o)).invite.scopes).toEqual(["tokens:write"]);
  });
});
