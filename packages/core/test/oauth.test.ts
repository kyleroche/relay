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
  issueAuthorizationCode,
  listPendingAccess,
  lookupDeviceRequest,
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
