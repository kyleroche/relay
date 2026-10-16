/**
 * RelayClient contract: the HTTP client against an in-process handler. `/mcp` is the real `createMcpHandler`; the
 * `/api/v1` routes are served by a small fake that implements the documented contract with the local client, so the
 * test pins the paths, bodies and response shapes both sides agree on. The local client is exercised alongside so the
 * two implementations answer the same calls the same way.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, migrate, repo, httpClient, localClient, RelayHttpError, SiteModeError, taskPath, type Db, type HttpFetch, type RelayClient } from "@relay/core";
import { createMcpHandler } from "../src/http.ts";

let db: Db;
let local: RelayClient;
let site: RelayClient;
let apiFetch: HttpFetch;
const TOKEN = "rly_test_token";
const calls: Array<{ method: string; path: string; body?: unknown }> = [];

beforeAll(async () => {
  db = await openDb({ file: ":memory:" });
  await migrate(db);
  await repo.upsertProject(db, { slug: "demo", repo: "acme/demo", path: "/tmp/demo" });
  local = localClient(db, { actor: "human:test", dispatch: false });
  const grant = { scopes: [...repo.TOKEN_SCOPES], actor: "token:grok-bot" };
  const mcp = createMcpHandler(db, { authorize: async (b) => (b === TOKEN ? grant : undefined) });

  const json = (status: number, body: unknown) => ({ ok: status < 400, status, headers: { get: () => "application/json" }, text: async () => JSON.stringify(body) });
  const problem = (status: number, title: string, detail: string, instance: string) => json(status, { type: "about:blank", title, status, detail, instance });

  // the fake /api/v1: same contract as apps/web/app/api/v1/*, served by the local client
  apiFetch = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method: init.method, path: u.pathname + u.search, body });
    if (init.headers.authorization !== `Bearer ${TOKEN}`) return problem(401, "Unauthorized", "Unknown token.", u.pathname);
    if (u.pathname === "/mcp") {
      const res = await mcp(new Request(url, { method: init.method, headers: init.headers, body: init.body }));
      return { ok: res.ok, status: res.status, headers: { get: (n: string) => res.headers.get(n) }, text: () => res.text() };
    }
    const p = u.pathname.replace(/^\/api\/v1/, "");
    const sp = u.searchParams;
    const admin = localClient(db, { actor: grant.actor, dispatch: false });
    if (p === "/info") return json(200, { name: "relay", version: "test" });
    if (p === "/feed") return json(200, { events: (await admin.listEvents({ limit: Number(sp.get("limit") ?? 50), ...(sp.get("kind") ? { kind: sp.get("kind")! } : {}) })).map(({ payload: _p, dedupe_key: _d, ...rest }) => rest) });
    if (p === "/usage") return json(200, { since: sp.get("since"), subscriptions: await admin.usageSummary(sp.get("since")!) });
    if (p === "/events" && init.method === "POST") {
      const row = await admin.logEvent(body as unknown as Parameters<RelayClient["logEvent"]>[0]);
      return json(201, { event: row });
    }
    if (p === "/projects" && init.method === "GET") return json(200, { projects: (await admin.listProjects()).map((x) => ({ slug: x.slug, repo: x.repo ?? "", stack: x.stack, summary: x.summary })) });
    const m = /^\/projects\/([^/]+)(\/.*)?$/.exec(p);
    if (m) {
      const slug = decodeURIComponent(m[1]!);
      if (!m[2] && init.method === "GET") {
        const row = await admin.getProject(slug);
        return row ? json(200, { ...row, repo: row.repo ?? "" }) : problem(404, "Not Found", `No project with slug '${slug}'.`, u.pathname);
      }
      if (!m[2] && init.method === "PUT") {
        const b = body as { repo?: string; path?: string; stack?: string; check_cmd?: string };
        await admin.registerProject({ slug, ...(b.repo ? { repo: b.repo } : {}), ...(b.path ? { path: b.path } : {}), ...(b.stack ? { stack: b.stack } : {}), ...(b.check_cmd ? { checkCmd: b.check_cmd } : {}) });
        return json(200, { project: await admin.getProject(slug) });
      }
      if (m[2] === "/digests") return json(200, await admin.putDigests(slug, (body as { files: Parameters<RelayClient["putDigests"]>[1] }).files, { prune: !!(body as { prune?: boolean }).prune }));
      if (m[2] === "/summary") {
        const b = body as { summary: string; tokens: number };
        await admin.putSummary(slug, b.summary, b.tokens);
        return json(200, { slug, tokens: b.tokens });
      }
      if (m[2] === "/decisions") return json(200, { decisions: await admin.listDecisions(slug, { current: sp.get("current") === "1" }) });
    }
    if (p === "/tokens" && init.method === "POST") {
      const { token, row } = await admin.createToken(body as { name: string; scopes: string[] });
      return json(201, { ...row, token });
    }
    if (p === "/tokens" && init.method === "GET") return json(200, { tokens: await admin.listTokens({ includeRevoked: sp.get("all") === "1" }) });
    const tk = /^\/tokens\/([^/]+)$/.exec(p);
    if (tk && init.method === "DELETE") {
      const row = await admin.revokeToken(decodeURIComponent(tk[1]!));
      return row ? json(200, { revoked: row }) : problem(404, "Not Found", "No live token matches.", u.pathname);
    }
    if (p === "/tasks" && init.method === "GET") return json(200, { tasks: await admin.listTasks({ ...(sp.get("state") ? { state: sp.get("state") as "queued" } : {}) }) });
    const task = /^\/tasks\/(.+)$/.exec(p);
    if (task) {
      const id = task[1]!.split("/").map(decodeURIComponent).join("/");
      const t = await admin.getTask(id);
      return t ? json(200, t) : problem(404, "Not Found", `No task ${id}.`, u.pathname);
    }
    if (p === "/webhooks" && init.method === "POST") return json(201, await admin.addWebhook(body as unknown as Parameters<RelayClient["addWebhook"]>[0]));
    if (p === "/webhooks" && init.method === "GET") return json(200, { webhooks: await admin.listWebhooks() });
    const wh = /^\/webhooks\/([^/]+)(\/test)?$/.exec(p);
    if (wh && init.method === "DELETE") return (await admin.removeWebhook(wh[1]!)) ? json(200, { removed: wh[1] }) : problem(404, "Not Found", "No webhook.", u.pathname);
    return problem(404, "Not Found", "No such operation.", u.pathname);
  };
  site = httpClient({ site: "https://relay.test/", token: TOKEN, fetch: apiFetch });
});
afterAll(async () => {
  await db.close();
});

describe("RelayClient over HTTP", () => {
  it("normalises the site URL and sends the bearer to it only", async () => {
    expect(site.site).toBe("https://relay.test");
    expect(site.mode).toBe("site");
    const health = await site.health();
    expect(health.ok).toBe(true);
    expect(calls.every((c) => c.path.startsWith("/api/v1/") || c.path === "/mcp")).toBe(true);
  });

  it("reports a rejected token as a RelayHttpError with the problem fields", async () => {
    const bad = httpClient({ site: "https://relay.test", token: "wrong", fetch: apiFetch });
    expect((await bad.health()).ok).toBe(false);
    await expect(bad.listProjects()).rejects.toBeInstanceOf(RelayHttpError);
    await expect(bad.listProjects()).rejects.toMatchObject({ status: 401, title: "Unauthorized" });
  });

  it("projects: register, get, upload digests and summary", async () => {
    await site.registerProject({ slug: "web", repo: "acme/web", path: "/srv/web", stack: "next" });
    expect(calls.at(-1)).toMatchObject({ method: "PUT", path: "/api/v1/projects/web", body: { repo: "acme/web", path: "/srv/web", stack: "next" } });
    const p = await site.getProject("web");
    expect(p?.repo).toBe("acme/web");
    expect(await site.getProject("ghost")).toBeUndefined();
    const r = await site.putDigests("web", [{ path: "src/a.ts", sha256: "a".repeat(64), size: 10, summary: "Exports the thing that does the work for module a.", tokens: 12 }], { prune: true });
    expect(r.files).toBe(1);
    expect((await repo.listFileDigests(db, "web"))[0]).toMatchObject({ path: "src/a.ts", summary_sha: "a".repeat(64) });
    const summary = `## Purpose\n${"word ".repeat(40)}\n## Stack and layout\n${"word ".repeat(40)}\n## Commands\n${"word ".repeat(30)}\n## Conventions\n${"word ".repeat(30)}\n## Gotchas\n${"word ".repeat(30)}`;
    await site.putSummary("web", summary, 200);
    expect((await local.getProject("web"))?.summary_tokens).toBe(200);
    expect((await site.listProjects()).map((x) => x.slug).sort()).toEqual(["demo", "web"]);
  });

  it("memory goes through /mcp: decide, prefer, recall, brief; history through REST", async () => {
    const d = await site.decide({ project: "demo", text: "We use vitest because it runs PGlite in-process", source: "human" });
    expect(d.id).toBeGreaterThan(0);
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/mcp" });
    expect((calls.at(-1)!.body as { params: { name: string } }).params.name).toBe("relay_decide");
    await site.prefer({ key: "test_runner", value: "vitest", scope: "project", scopeId: "demo" });
    const r = await site.recall({ project: "demo", query: "tests" });
    expect(r.text).toContain("vitest");
    const b = await site.brief({ project: "demo", intent: "add a test", maxTokens: 1000 });
    expect(b.text).toContain("vitest");
    expect(b.tokens).toBeGreaterThan(0);
    const hist = await site.listDecisions("demo", { current: true });
    expect(hist.map((x) => x.id)).toContain(d.id);
    await expect(site.decide({ project: null, text: "global rule because reasons", source: "human" })).rejects.toBeInstanceOf(SiteModeError);
    // the MCP write was attributed to the token, as a bot
    const ev = (await local.listEvents({ kind: "decision.captured", limit: 1 }))[0];
    expect(ev?.actor).toBe("token:grok-bot");
  });

  it("events: only external.* kinds, actor from the token", async () => {
    const row = await site.logEvent({ kind: "external.briefing", project: "demo", summary: "Morning brief sent", url: "https://bot.example/b/1", source: "grok-bot" });
    expect(row?.kind).toBe("external.briefing");
    expect(row?.actor).toBe("bot:grok-bot");
    await expect(local.logEvent({ kind: "run.started", summary: "forged" })).rejects.toThrow(/external\./);
    const feed = await site.listEvents({ kind: "external.", limit: 5 });
    expect(feed[0]?.payload).toEqual({});
    expect(feed[0]?.dedupe_key).toBeNull();
  });

  it("tokens: create returns the plaintext once; list and revoke", async () => {
    const { token, row } = await site.createToken({ name: "ci", scopes: ["feed:read", "tasks:read"] });
    expect(token).toMatch(/^rly_/);
    expect(row.scopes).toEqual(["feed:read", "tasks:read"]);
    expect((await site.listTokens()).some((t) => t.id === row.id)).toBe(true);
    expect((await site.revokeToken("ci"))?.id).toBe(row.id);
    expect(await site.revokeToken("ci")).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/api/v1/tokens/ci" });
  });

  it("tasks: ids travel with %23 and come back with derived state", async () => {
    expect(taskPath("acme/demo#42")).toBe("acme/demo%2342");
    await repo.createTask(db, { project: "demo", repo: "acme/demo", issue: 42, createdBy: "human:test" });
    await repo.writeEvent(db, { kind: "run.started", actor: "runner:mini", repo: "acme/demo", issue: 42, lane: "claude", summary: "go" });
    const t = await site.getTask("acme/demo#42");
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/api/v1/tasks/acme/demo%2342" });
    expect(t).toMatchObject({ id: "acme/demo#42", state: "running", runner: "runner:mini", lane: "claude" });
    expect((await site.listTasks({ state: "running" })).map((x) => x.id)).toEqual(["acme/demo#42"]);
    expect(await site.getTask("acme/demo#999")).toBeUndefined();
  });

  it("webhooks: add shows the secret once, list hides it, rm removes", async () => {
    const r = await site.addWebhook({ url: "https://bot.example/relay", events: ["pr.merged", "run.failed"], bearer: "bk" });
    expect(r.secret).toMatch(/^whsec_/);
    expect(r.webhook).not.toHaveProperty("secret");
    expect(r.webhook.has_bearer).toBe(true);
    const list = await site.listWebhooks();
    expect(list.map((w) => w.id)).toContain(r.webhook.id);
    expect(await site.removeWebhook(r.webhook.id)).toBe(true);
    expect(await site.removeWebhook(r.webhook.id)).toBe(false);
  });
});
