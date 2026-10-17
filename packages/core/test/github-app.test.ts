import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
import { appConfigFromEnv, appJwt, GitHubApp, normalizePem, repoHasRelayFile } from "../src/github/app.ts";
import { detectGitHub, GitHubError, type GitHubFetch } from "../src/github/client.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString(); // what GitHub downloads
const spki = publicKey.export({ type: "spki", format: "pem" }).toString();

interface Call {
  method: string;
  url: string;
  auth: string;
  body?: string;
}

/** A GitHub API stand-in that checks the JWT on app calls and the installation token on repo calls. */
function fakeGitHub(opts: { installations?: Record<string, number>; files?: string[]; tokenTtlSeconds?: number } = {}) {
  const calls: Call[] = [];
  let minted = 0;
  let now = Date.parse("2026-10-16T10:00:00.000Z");
  const fetchImpl: GitHubFetch = async (url, init) => {
    const u = new URL(url);
    const auth = init.headers.authorization ?? "";
    calls.push({ method: init.method, url: u.pathname, auth, ...(init.body ? { body: init.body } : {}) });
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    const token = auth.replace(/^Bearer /, "");
    const isJwt = token.split(".").length === 3;
    if (u.pathname.startsWith("/app/") || u.pathname.endsWith("/installation")) {
      if (!isJwt) return reply(401, { message: "Bad credentials" });
      await jwtVerify(token, await importSPKI(spki, "RS256"), { issuer: "4242", currentDate: new Date(now) });
    }
    const inst = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(u.pathname);
    if (inst) {
      const id = opts.installations?.[inst[1]!];
      return id ? reply(200, { id, account: { login: inst[1]!.split("/")[0] } }) : reply(404, { message: "Not Found" });
    }
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(u.pathname);
    if (mint && init.method === "POST") {
      minted++;
      return reply(201, { token: `ghs_${mint[1]}_${minted}`, expires_at: new Date(now + (opts.tokenTtlSeconds ?? 3600) * 1000).toISOString() });
    }
    if (u.pathname === "/app/installations") return reply(200, [{ id: 7, account: { login: "acme", type: "Organization" }, repository_selection: "selected", html_url: "https://github.com/organizations/acme/settings/installations/7", created_at: "2026-10-01T00:00:00Z", suspended_at: null }]);
    if (!token.startsWith("ghs_")) return reply(401, { message: "installation token required" });
    const contents = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(u.pathname);
    if (contents) return (opts.files ?? []).includes(`${contents[1]}/${contents[2]}`) ? reply(200, { name: contents[2] }) : reply(404, { message: "Not Found" });
    if (/^\/repos\/[^/]+\/[^/]+\/issues$/.test(u.pathname) && init.method === "POST") {
      const b = JSON.parse(init.body ?? "{}") as { title: string; labels?: string[] };
      return reply(201, { number: 11, title: b.title, body: "", state: "open", html_url: `https://github.com${u.pathname}/11`, labels: (b.labels ?? []).map((l) => ({ name: l })) });
    }
    if (/\/issues\/\d+\/comments$/.test(u.pathname)) return reply(201, { id: 1 });
    return reply(404, { message: `unhandled ${init.method} ${u.pathname}` });
  };
  return { fetch: fetchImpl, calls, minted: () => minted, now: () => now, advance: (s: number) => (now += s * 1000) };
}

describe("GitHub App", () => {
  it("normalises a key pasted into one environment variable", () => {
    const oneLine = pkcs1.replace(/\n/g, "\\n");
    expect(normalizePem(`"${oneLine}"`)).toBe(pkcs1.trim() + "\n");
    expect(normalizePem(Buffer.from(pkcs1).toString("base64"))).toBe(pkcs1.trim() + "\n");
    expect(appConfigFromEnv({ GITHUB_APP_ID: "4242", GITHUB_APP_PRIVATE_KEY: oneLine })?.appId).toBe("4242");
    expect(appConfigFromEnv({ GITHUB_APP_ID: "4242" })).toBeUndefined();
  });

  it("mints an RS256 app JWT GitHub would accept (iss = app id, iat skewed back, exp under 10 minutes)", async () => {
    const now = Date.parse("2026-10-16T10:00:00.000Z");
    const jwt = await appJwt({ appId: "4242", privateKey: pkcs1 }, now);
    const { payload, protectedHeader } = await jwtVerify(jwt, await importSPKI(spki, "RS256"), { issuer: "4242", currentDate: new Date(now) });
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.iat).toBe(Math.floor(now / 1000) - 60);
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(600);
  });

  it("discovers the installation per repo, mints and caches installation tokens, refreshes before expiry", async () => {
    const gh = fakeGitHub({ installations: { "acme/site": 7, "acme/docs": 7, "other/thing": 9 }, tokenTtlSeconds: 3600 });
    const app = new GitHubApp({ appId: "4242", privateKey: pkcs1 }, { fetch: gh.fetch, now: gh.now });
    expect(await app.installationFor("acme/site")).toBe(7);
    expect(await app.installationFor("acme/site")).toBe(7); // cached
    expect(gh.calls.filter((c) => c.url.endsWith("/installation")).length).toBe(1);
    const t1 = await app.tokenFor("acme/site");
    const t2 = await app.tokenFor("acme/docs"); // same installation, same token
    expect(t1).toBe(t2);
    expect(gh.minted()).toBe(1);
    const t3 = await app.tokenFor("other/thing");
    expect(t3).not.toBe(t1);
    expect(gh.minted()).toBe(2);
    gh.advance(3600 - 30); // inside the refresh margin
    const t4 = await app.tokenFor("acme/site");
    expect(t4).not.toBe(t1);
    expect(gh.minted()).toBe(3);
    await expect(app.installationFor("nobody/here")).rejects.toThrow(/not installed on nobody\/here/);
    const list = await app.listInstallations();
    expect(list[0]).toMatchObject({ id: 7, account: "acme", repository_selection: "selected" });
  });

  it("the GitHubClient it hands out opens issues with an installation token and exposes request()", async () => {
    const gh = fakeGitHub({ installations: { "acme/site": 7 }, files: ["acme/site/relay.md"] });
    const app = new GitHubApp({ appId: "4242", privateKey: pkcs1, slug: "relay-acme" }, { fetch: gh.fetch, now: gh.now });
    const client = app.client();
    expect(client.source).toBe("app");
    const issue = await client.createIssue("acme/site", { title: "Hello", body: "x", labels: ["agent:codex"] });
    expect(issue.number).toBe(11);
    expect(issue.labels).toEqual(["agent:codex"]);
    const issueCall = gh.calls.find((c) => c.url === "/repos/acme/site/issues");
    expect(issueCall?.auth).toMatch(/^Bearer ghs_7_/);
    await client.request("POST", "/repos/acme/site/issues/11/comments", { body: "hi" });
    await expect(client.request("GET", "/user")).rejects.toBeInstanceOf(GitHubError);
    expect(await repoHasRelayFile(app, "acme/site")).toBe(true);
    expect(await repoHasRelayFile(app, "acme/site", 7)).toBe(true);
    expect(app.installUrl()).toBe("https://github.com/apps/relay-acme/installations/new");
  });

  it("detectGitHub prefers the app over a token over gh", () => {
    const app = detectGitHub({ GITHUB_APP_ID: "4242", GITHUB_APP_PRIVATE_KEY: pkcs1, GITHUB_TOKEN: "ghp_x" }, { allowGh: false });
    expect(app?.source).toBe("app");
    expect(detectGitHub({ GITHUB_TOKEN: "ghp_x" }, { allowGh: false })?.source).toBe("token");
    expect(detectGitHub({}, { allowGh: false })).toBeUndefined();
  });
});
