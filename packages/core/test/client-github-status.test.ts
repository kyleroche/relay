/**
 * `RelayClient.githubStatus` on both sides: the HTTP client against a stub site (path, bearer, 404 → undefined) and the
 * local client over PGlite (no App; the webhook statistics come from the repo's `github:` deliveries in the feed).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpClient, localClient, migrate, openDb, repo, type Db, type GitHubStatus, type HttpFetch, type RelayClient } from "../src/index.ts";

const TOKEN = "rly_status_token";
const STATUS: GitHubStatus = {
  repo: "acme/demo",
  app: { configured: true, slug: "relay-acme", installed: false, installation_id: null, install_url: "https://github.com/apps/relay-acme/installations/new" },
  webhook: { org_or_repo_hook_seen: false, last_delivery_at: null },
};

describe("httpClient.githubStatus", () => {
  const calls: Array<{ method: string; path: string; auth: string | undefined }> = [];
  const stub: HttpFetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, auth: init.headers.authorization });
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, headers: { get: () => "application/json" }, text: async () => JSON.stringify(body) });
    if (init.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { title: "Unauthorized", detail: "Unknown token.", instance: u.pathname });
    if (u.pathname === "/api/v1/projects/demo/github") return json(200, STATUS);
    if (u.pathname === "/api/v1/projects/a%2Fb/github") return json(200, { ...STATUS, repo: "x/a-b" });
    return json(404, { title: "Not Found", detail: "No project.", instance: u.pathname });
  };

  it("GETs /api/v1/projects/{slug}/github with the bearer and returns the body as is", async () => {
    const site = httpClient({ site: "https://relay.test/", token: TOKEN, fetch: stub });
    const s = await site.githubStatus("demo");
    expect(s).toEqual(STATUS);
    expect(calls.at(-1)).toEqual({ method: "GET", path: "/api/v1/projects/demo/github", auth: `Bearer ${TOKEN}` });
    // the slug is URL-encoded on the path
    expect((await site.githubStatus("a/b"))?.repo).toBe("x/a-b");
  });

  it("answers undefined for an unknown project and throws on anything else", async () => {
    const site = httpClient({ site: "https://relay.test", token: TOKEN, fetch: stub });
    expect(await site.githubStatus("nope")).toBeUndefined();
    const bad = httpClient({ site: "https://relay.test", token: "wrong", fetch: stub });
    await expect(bad.githubStatus("demo")).rejects.toMatchObject({ status: 401 });
  });
});

describe("localClient.githubStatus", () => {
  let db: Db;
  let local: RelayClient;
  beforeAll(async () => {
    db = await openDb({ file: ":memory:" });
    await migrate(db);
    await repo.upsertProject(db, { slug: "demo", repo: "acme/demo" });
    await repo.upsertProject(db, { slug: "bare" });
    local = localClient(db, { actor: "human:test", dispatch: false, installUrl: "https://relay.test/setup/github" });
  });
  afterAll(async () => {
    await db.close();
  });

  it("reports no App, the install link it was given, and no deliveries yet", async () => {
    expect(await local.githubStatus("demo")).toEqual({
      repo: "acme/demo",
      app: { configured: false, slug: null, installed: false, installation_id: null, install_url: "https://relay.test/setup/github" },
      webhook: { org_or_repo_hook_seen: false, last_delivery_at: null },
    });
    expect((await local.githubStatus("bare"))?.repo).toBeNull();
    expect(await local.githubStatus("missing")).toBeUndefined();
    expect((await localClient(db, { actor: "human:test", dispatch: false }).githubStatus("demo"))?.app.install_url).toBe("https://github.com/settings/installations");
  });

  it("counts the repo's GitHub deliveries (github: dedupe keys) and reports the newest", async () => {
    await repo.writeEvent(db, { kind: "issue.opened", actor: "human:kyle", project: "demo", repo: "acme/demo", summary: "first", ts: "2026-10-01T10:00:00.000Z", dedupe_key: "github:d1" });
    await repo.writeEvent(db, { kind: "pr.opened", actor: "human:kyle", project: "demo", repo: "acme/demo", summary: "second", ts: "2026-10-02T10:00:00.000Z", dedupe_key: "github:d2" });
    // a Vercel delivery and a local write for the same repo do not count
    await repo.writeEvent(db, { kind: "preview.ready", actor: "bot:vercel", project: "demo", repo: "acme/demo", summary: "preview", ts: "2026-10-03T10:00:00.000Z", dedupe_key: "vercel:v1" });
    await repo.writeEvent(db, { kind: "project.linked", actor: "human:kyle", project: "demo", repo: "acme/demo", summary: "linked", ts: "2026-10-04T10:00:00.000Z" });
    const s = await local.githubStatus("demo");
    expect(s?.webhook).toEqual({ org_or_repo_hook_seen: true, last_delivery_at: "2026-10-02T10:00:00.000Z" });
    expect(await repo.githubDeliveryStats(db, "acme/demo")).toEqual({ count: 2, last_delivery_at: "2026-10-02T10:00:00.000Z" });
    expect(await repo.githubDeliveryStats(db, "acme/other")).toEqual({ count: 0, last_delivery_at: null });
  });
});
