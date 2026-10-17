/**
 * `githubStatusFor`, the logic behind GET /api/v1/projects/{slug}/github, against a fake GitHub: installed, not
 * installed (404), the App failing (500), no App at all, and the delivery statistics passed through.
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { GitHubApp, type GitHubFetch } from "@relay/core";
import { githubStatusFor } from "../lib/github-status.ts";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();

/** Answers only installation discovery: a map of repo → installation id; anything unknown is 404, "acme/broken" is 500. */
function fakeGitHub(installations: Record<string, number>) {
  const calls: string[] = [];
  const fetchImpl: GitHubFetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method} ${path}`);
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    const m = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(path);
    if (!m) return reply(404, { message: `unhandled ${path}` });
    if (m[1] === "acme/broken") return reply(500, { message: "boom" });
    const id = installations[m[1]!];
    return id ? reply(200, { id }) : reply(404, { message: "Not Found" });
  };
  return { fetch: fetchImpl, calls };
}

const SITE = "https://relay.test";

describe("githubStatusFor", () => {
  it("installed: the installation id and the App's own install page", async () => {
    const gh = fakeGitHub({ "acme/demo": 7 });
    const app = new GitHubApp({ appId: "4242", privateKey: pem, slug: "relay-acme" }, { fetch: gh.fetch });
    const s = await githubStatusFor("acme/demo", { app, slug: "relay-acme", siteUrl: SITE, delivery: { count: 3, last_delivery_at: "2026-10-16T10:00:00.000Z" } });
    expect(s).toEqual({
      repo: "acme/demo",
      app: { configured: true, slug: "relay-acme", installed: true, installation_id: 7, install_url: "https://github.com/apps/relay-acme/installations/new" },
      webhook: { org_or_repo_hook_seen: true, last_delivery_at: "2026-10-16T10:00:00.000Z" },
    });
    expect(gh.calls).toEqual(["GET /repos/acme/demo/installation"]);
  });

  it("not installed: GitHub's 404 is the answer, not an error", async () => {
    const gh = fakeGitHub({});
    const app = new GitHubApp({ appId: "4242", privateKey: pem }, { fetch: gh.fetch });
    const s = await githubStatusFor("acme/demo", { app, slug: null, siteUrl: SITE, delivery: { count: 0, last_delivery_at: null } });
    expect(s.app).toEqual({ configured: true, slug: null, installed: false, installation_id: null, install_url: "https://github.com/settings/installations" });
    expect(s.webhook).toEqual({ org_or_repo_hook_seen: false, last_delivery_at: null });
  });

  it("a failing App check reports installed=false with the reason", async () => {
    const gh = fakeGitHub({});
    const app = new GitHubApp({ appId: "4242", privateKey: pem, slug: "relay-acme" }, { fetch: gh.fetch });
    const s = await githubStatusFor("acme/broken", { app, siteUrl: SITE });
    expect(s.app.installed).toBe(false);
    expect(s.app.error).toMatch(/500/);
    expect(s.webhook).toBeUndefined();
  });

  it("no App configured: install_url is the site's setup page and nothing is asked of GitHub", async () => {
    const s = await githubStatusFor("acme/demo", { siteUrl: SITE, delivery: { count: 0, last_delivery_at: null } });
    expect(s.app).toEqual({ configured: false, slug: null, installed: false, installation_id: null, install_url: `${SITE}/setup/github` });
  });

  it("a project without a repo cannot be installed on", async () => {
    const gh = fakeGitHub({ "acme/demo": 7 });
    const app = new GitHubApp({ appId: "4242", privateKey: pem, slug: "relay-acme" }, { fetch: gh.fetch });
    const s = await githubStatusFor(null, { app, siteUrl: SITE });
    expect(s).toMatchObject({ repo: null, app: { configured: true, installed: false, installation_id: null } });
    expect(gh.calls).toEqual([]);
  });
});
