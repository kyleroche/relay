import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { deviceAuthorization, exchangeToken, GRANT_DEVICE_CODE, GRANT_INVITE, OAuthError, openDb, migrate, repo, approxTokens, LocalStore, TOKEN_SCOPES, verifyLocalUploadUrl, type Db, type TokenScope } from "@relay/core";
import { createRelayServer, capText, grantedScopes, RESULT_TOKENS, TOOL_SCOPES, type RelayServerOptions } from "../src/server.ts";
import { createMcpHandler } from "../src/http.ts";

let db: Db;
let home: string;
let store: LocalStore;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "relay-mcp-"));
  delete process.env.RELAY_ASSET_SIGNING_KEY;
  store = new LocalStore(join(home, "assets"));
  db = await openDb({ file: ":memory:" });
  await migrate(db);
  await repo.upsertProject(db, { slug: "demo", repo: "acme/demo", path: "/tmp/demo", stack: "ts" });
  await repo.setProjectSummary(db, "demo", "Demo is a TypeScript service.", 8);
});
afterAll(async () => {
  await db.close();
  rmSync(home, { recursive: true, force: true });
});

async function connect(opts: Partial<RelayServerOptions> & { canWrite: boolean }) {
  const server = createRelayServer(db, { actor: "human:test", invalidateCache: false, assets: { store }, ...opts });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return { client, server };
}

const textOf = (r: Awaited<ReturnType<Client["callTool"]>>): string => (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
const jsonOf = <T>(r: Awaited<ReturnType<Client["callTool"]>>): T => JSON.parse(textOf(r)) as T;

describe("relay mcp tools", () => {
  it("lists one tool set, matching TOOL_SCOPES", async () => {
    const { client, server } = await connect({ canWrite: true });
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([...TOOL_SCOPES.map((t) => t.name)].sort());
    expect(tools).toEqual([
      "relay_access_approve",
      "relay_access_list",
      "relay_asset_finalize",
      "relay_asset_get",
      "relay_asset_list",
      "relay_asset_request_upload",
      "relay_brief",
      "relay_decide",
      "relay_event_log",
      "relay_feed",
      "relay_get_feed",
      "relay_get_info",
      "relay_get_methodology",
      "relay_get_project",
      "relay_guidance",
      "relay_invite_create",
      "relay_invite_revoke",
      "relay_prefer",
      "relay_project",
      "relay_recall",
      "relay_task_approve",
      "relay_task_create",
      "relay_task_get",
      "relay_task_list",
      "relay_task_release",
      "relay_task_request_changes",
      "relay_task_requeue",
      "relay_webhook_subscribe",
      "relay_webhook_unsubscribe",
      "relay_whoami",
    ]);
    await client.close();
    await server.close();
  });

  it("decide, prefer, recall, brief, project and feed round-trip", async () => {
    const { client, server } = await connect({ canWrite: true });
    const d = await client.callTool({ name: "relay_decide", arguments: { text: "We use vitest for tests because it runs PGlite in-process", project: "demo", source: "human" } });
    expect(d.isError).toBeFalsy();
    expect(textOf(d)).toMatch(/recorded decision #\d+/);

    const p = await client.callTool({ name: "relay_prefer", arguments: { key: "commit_style", value: "imperative, one topic", scope: "project", scope_id: "demo" } });
    expect(p.isError).toBeFalsy();

    const bad = await client.callTool({ name: "relay_prefer", arguments: { key: "x", value: "y", scope: "lane" } });
    expect(bad.isError).toBe(true);

    const r = textOf(await client.callTool({ name: "relay_recall", arguments: { query: "which test runner", project: "demo" } }));
    expect(r).toContain("vitest");
    expect(r).toContain("commit_style = imperative, one topic");

    const b = textOf(await client.callTool({ name: "relay_brief", arguments: { project: "demo", intent: "add a test" } }));
    expect(b).toContain("## Project: demo");
    expect(b).toContain("Demo is a TypeScript service.");
    expect(b).toContain("vitest");
    expect(approxTokens(b)).toBeLessThanOrEqual(RESULT_TOKENS);

    const pr = textOf(await client.callTool({ name: "relay_project", arguments: { slug: "demo" } }));
    expect(pr).toContain("repo: acme/demo");
    expect(pr).toContain("decisions: 1 current");

    const unknown = await client.callTool({ name: "relay_project", arguments: { slug: "nope" } });
    expect(unknown.isError).toBe(true);

    const f = textOf(await client.callTool({ name: "relay_feed", arguments: { project: "demo", limit: 10 } }));
    expect(f).toContain("decision.captured");
    expect(f).toContain("preference.set");

    const g = await client.callTool({ name: "relay_guidance", arguments: { model: "acme/none", query: "x" } });
    expect(g.isError).toBe(true);
    await client.close();
    await server.close();
  });

  it("public read tools answer from the database and sanitise events", async () => {
    const { client, server } = await connect({ canWrite: false });
    const info = jsonOf<{ name: string; data_mode: string; projects: Array<{ slug: string }>; tools: unknown[] }>(await client.callTool({ name: "relay_get_info", arguments: {} }));
    expect(info.name).toBe("relay");
    expect(info.data_mode).toBe("db");
    expect(info.projects.map((p) => p.slug)).toContain("demo");
    expect(info.tools.length).toBe(TOOL_SCOPES.length);

    expect(textOf(await client.callTool({ name: "relay_get_methodology", arguments: {} }))).toContain("Tasks move, credentials never do");

    const feed = jsonOf<{ events: Array<Record<string, unknown>>; count: number }>(await client.callTool({ name: "relay_get_feed", arguments: { project: "demo", limit: 5 } }));
    expect(feed.count).toBeGreaterThan(0);
    expect(feed.events[0]).not.toHaveProperty("payload");
    expect(feed.events[0]).not.toHaveProperty("dedupe_key");
    const onlyPrefs = jsonOf<{ events: Array<{ kind: string }> }>(await client.callTool({ name: "relay_get_feed", arguments: { kind: "preference.set" } }));
    expect(onlyPrefs.events.every((e) => e.kind === "preference.set")).toBe(true);

    const proj = jsonOf<{ slug: string; decisions: unknown[]; events: unknown[] }>(await client.callTool({ name: "relay_get_project", arguments: { slug: "demo" } }));
    expect(proj.slug).toBe("demo");
    expect(proj.decisions.length).toBe(1);
    expect((await client.callTool({ name: "relay_get_project", arguments: { slug: "nope" } })).isError).toBe(true);
    await client.close();
    await server.close();
  });

  it("site hooks replace the database answers", async () => {
    const { client, server } = await connect({ canWrite: false, site: { info: () => ({ name: "relay", from: "site" }), methodology: () => "site rules" } });
    expect(jsonOf<{ from: string }>(await client.callTool({ name: "relay_get_info", arguments: {} })).from).toBe("site");
    expect(textOf(await client.callTool({ name: "relay_get_methodology", arguments: {} }))).toBe("site rules");
    await client.close();
    await server.close();
  });

  it("refuses writes on a read-only connection but still reads", async () => {
    const { client, server } = await connect({ canWrite: false });
    const d = await client.callTool({ name: "relay_decide", arguments: { text: "We never do this because read-only", project: "demo" } });
    expect(d.isError).toBe(true);
    expect(textOf(d)).toMatch(/read-only/);
    const r = textOf(await client.callTool({ name: "relay_recall", arguments: { query: "vitest", project: "demo" } }));
    expect(r).toContain("vitest");
    // asset reads are not part of the public read scopes
    const a = await client.callTool({ name: "relay_asset_list", arguments: {} });
    expect(a.isError).toBe(true);
    expect(textOf(a)).toMatch(/assets:read/);
    await client.close();
    await server.close();
  });

  it("asset tools: request upload, PUT, finalize, get, list", async () => {
    const { client, server } = await connect({ canWrite: false, scopes: ["assets:read", "assets:write"] });
    const req = jsonOf<{ id: string; key: string; upload_url: string; method: string; headers: Record<string, string>; then: { tool: string } }>(
      await client.callTool({ name: "relay_asset_request_upload", arguments: { project: "demo", filename: "sketch.svg" } }),
    );
    expect(req.method).toBe("PUT");
    expect(req.headers["content-type"]).toBe("image/svg+xml");
    expect(req.key).toBe(`demo/${req.id}/sketch.svg`);
    expect(req.then.tool).toBe("relay_asset_finalize");
    const v = verifyLocalUploadUrl(req.upload_url, store);
    expect(v.ok).toBe(true);
    // the "client" uploads straight to the store, as a CLI on this machine would
    await store.put(req.key, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), { contentType: "image/svg+xml" });

    const fin = jsonOf<{ id: string; kind: string; status: string; url: string; storage_key?: string }>(
      await client.callTool({ name: "relay_asset_finalize", arguments: { key: req.key, project: "demo", title: "Sketch", issue: 4, tags: ["ux"] } }),
    );
    expect(fin.id).toBe(req.id);
    expect(fin.kind).toBe("image");
    expect(fin.status).toBe("pending");
    expect(fin.url.startsWith("file://")).toBe(true);
    expect(fin).not.toHaveProperty("storage_key");

    const got = jsonOf<{ id: string; title: string; url: string; versions: Array<{ version: number }> }>(await client.callTool({ name: "relay_asset_get", arguments: { id: req.id } }));
    expect(got.title).toBe("Sketch");
    expect(got.versions.map((x) => x.version)).toEqual([1]);

    const list = jsonOf<{ assets: Array<{ id: string }>; count: number }>(await client.callTool({ name: "relay_asset_list", arguments: { project: "demo", status: "pending" } }));
    expect(list.assets.map((a) => a.id)).toContain(req.id);

    const twice = await client.callTool({ name: "relay_asset_finalize", arguments: { key: "demo/nope", project: "demo" } });
    expect(twice.isError).toBe(true);
    const unknownProject = await client.callTool({ name: "relay_asset_request_upload", arguments: { project: "ghost", filename: "x.png" } });
    expect(unknownProject.isError).toBe(true);
    // write scope does not include memory
    expect((await client.callTool({ name: "relay_recall", arguments: { query: "x" } })).isError).toBe(true);
    await client.close();
    await server.close();
  });

  it("whoami and webhook subscribe/unsubscribe over a scoped connection", async () => {
    const { client, server } = await connect({ canWrite: false, scopes: ["webhooks:write"], actor: "token:oauth:grok-bot", identity: { name: "oauth:grok-bot", expires_at: "2026-10-17T10:00:00.000Z", source: "db" } });
    const who = jsonOf<{ actor: string; name: string; scopes: string[]; expires_at: string; source: string; authenticated: boolean }>(await client.callTool({ name: "relay_whoami", arguments: {} }));
    expect(who).toMatchObject({ actor: "token:oauth:grok-bot", name: "oauth:grok-bot", scopes: ["webhooks:write"], expires_at: "2026-10-17T10:00:00.000Z", source: "db", authenticated: true });

    const sub = jsonOf<{ webhook: { id: string; url: string; events: string[]; has_bearer: boolean; project: string | null; created_by: string }; secret: string }>(
      await client.callTool({ name: "relay_webhook_subscribe", arguments: { url: "https://grok.example/routines/relay", events: ["pr.merged", "run."], bearer: "rk_1", project: "demo" } }),
    );
    expect(sub.secret).toMatch(/^whsec_/);
    expect(sub.webhook).toMatchObject({ url: "https://grok.example/routines/relay", events: ["pr.merged", "run."], has_bearer: true, project: "demo", created_by: "bot:oauth:grok-bot" });
    expect(sub.webhook).not.toHaveProperty("secret");
    expect((await repo.getWebhook(db, sub.webhook.id))?.bearer).toBe("rk_1");

    expect((await client.callTool({ name: "relay_webhook_subscribe", arguments: { url: "ftp://x", events: ["*"] } })).isError).toBe(true);
    expect((await client.callTool({ name: "relay_webhook_subscribe", arguments: { url: "https://x.example", events: ["*"], project: "ghost" } })).isError).toBe(true);

    expect(jsonOf<{ removed: string }>(await client.callTool({ name: "relay_webhook_unsubscribe", arguments: { id: sub.webhook.id } })).removed).toBe(sub.webhook.id);
    expect((await client.callTool({ name: "relay_webhook_unsubscribe", arguments: { id: sub.webhook.id } })).isError).toBe(true);
    expect(await repo.getWebhook(db, sub.webhook.id)).toBeUndefined();
    await client.close();
    await server.close();
  });

  it("task review tools: approve merges and request-changes queues; scope and self-approval refusals", async () => {
    // a task in review with its PR, produced by the codex lane on worker "codex-bot"
    await repo.createTask(db, { project: "demo", repo: "acme/demo", issue: 77, createdBy: "bot:grok", lane: "codex" });
    const base = { project: "demo", repo: "acme/demo", issue: 77, lane: "codex" };
    await repo.writeEvent(db, { ...base, kind: "run.started", actor: "runner:codex-bot", summary: "codex on codex-bot", payload: { branch: "relay/codex-77" }, ts: "2026-10-16T10:01:00.000Z" });
    await repo.writeEvent(db, { ...base, kind: "pr.opened", actor: "agent:codex", summary: "codex: Add dark mode (#77)", pr: 9, url: "https://github.com/acme/demo/pull/9", payload: { branch: "relay/codex-77" }, ts: "2026-10-16T10:06:00.000Z" });
    await repo.writeEvent(db, { ...base, kind: "preview.ready", actor: "bot:vercel", issue: null, pr: 9, summary: "Preview deployed for #9", url: "https://demo-git-relay-codex-77.vercel.app", payload: { ref: "relay/codex-77" }, ts: "2026-10-16T10:08:00.000Z" });
    const merged: number[] = [];
    const comments: string[] = [];
    const github = {
      source: "token" as const,
      createIssue: async () => ({ number: 1, title: "", body: "", state: "open", html_url: "", labels: [] }),
      addLabels: async () => {},
      removeLabel: async () => {},
      getIssue: async () => ({ number: 77, title: "t", body: "", state: "open", html_url: "", labels: [] }),
      request: async () => ({}),
      createComment: async (_r: string, n: number, body: string) => (comments.push(body), { id: 1, html_url: `https://github.com/acme/demo/pull/${n}#issuecomment-1` }),
      getPullRequest: async (_r: string, n: number) => ({ number: n, title: "codex: Add dark mode", state: "open", merged: false, html_url: `https://github.com/acme/demo/pull/${n}`, head_ref: "relay/codex-77", head_sha: "abc", base_ref: "main", user: "relay-agent" }),
      mergePullRequest: async (_r: string, n: number) => (merged.push(n), { sha: "deadbeef", merged: true, message: "ok" }),
      deleteBranch: async () => {},
    };
    const events: repo.EventRow[] = [];

    // the task carries its preview for whoever asks
    const reader = await connect({ canWrite: false, scopes: ["tasks:read"] });
    const view = jsonOf<{ state: string; preview_url: string; preview_state: string; pr_url: string }>(await reader.client.callTool({ name: "relay_task_get", arguments: { task_id: "acme/demo#77" } }));
    expect(view).toMatchObject({ state: "review", preview_url: "https://demo-git-relay-codex-77.vercel.app", preview_state: "ready", pr_url: "https://github.com/acme/demo/pull/9" });
    for (const name of ["relay_task_approve", "relay_task_request_changes"]) {
      const r = await reader.client.callTool({ name, arguments: { id: "acme/demo#77", note: "x" } });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/tasks:write/);
    }
    await reader.client.close();
    await reader.server.close();

    // the lane's own bot cannot approve its PR
    const self = await connect({ canWrite: false, scopes: ["tasks:write"], actor: "token:oauth:codex-bot", github, afterEvent: (row) => void events.push(row) });
    const refused = await self.client.callTool({ name: "relay_task_approve", arguments: { id: "acme/demo#77" } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/its own work/);
    expect(merged).toEqual([]);
    await self.client.close();
    await self.server.close();

    // another bot sends it back, then approves the second attempt
    const grok = await connect({ canWrite: false, scopes: ["tasks:write", "tasks:read"], actor: "token:oauth:grok-bot", github, afterEvent: (row) => void events.push(row) });
    const back = jsonOf<{ state: string; review: { decided: string; by: string; note: string } }>(await grok.client.callTool({ name: "relay_task_request_changes", arguments: { id: "acme/demo#77", note: "Focus ring missing." } }));
    expect(back.state).toBe("queued");
    expect(back.review).toMatchObject({ decided: "changes_requested", by: "bot:oauth:grok-bot", note: "Focus ring missing." });
    expect(comments[0]).toContain("relay: changes requested by bot:oauth:grok-bot:");
    expect(events.map((e) => e.kind)).toEqual(["task.changes_requested"]);
    // not in review any more
    expect((await grok.client.callTool({ name: "relay_task_approve", arguments: { id: "acme/demo#77" } })).isError).toBe(true);
    // written with the database clock, like the decision above, so it sorts after it
    await repo.writeEvent(db, { ...base, kind: "run.finished", actor: "runner:codex-bot", summary: "Added the ring", pr: 9, payload: { conclusion: "success" } });
    const ok = jsonOf<{ state: string; merged_at: string | null; review: { decided: string } }>(await grok.client.callTool({ name: "relay_task_approve", arguments: { id: "acme/demo#77" } }));
    expect(ok.state).toBe("done");
    expect(ok.merged_at).toBeTruthy();
    expect(ok.review.decided).toBe("approved");
    expect(merged).toEqual([9]);
    expect(events.map((e) => e.kind)).toEqual(["task.changes_requested", "task.approved"]);
    expect(events[1]?.actor).toBe("bot:oauth:grok-bot");
    await grok.client.close();
    await grok.server.close();
  });

  it("requeues a task stuck on a cloud lane onto a worker lane, moving the label; done and tasks:read callers are refused", async () => {
    // opened by a bot on claude-cloud and dispatched: it looks running, but nothing will ever happen
    await repo.createTask(db, { project: "demo", repo: "acme/demo", issue: 78, createdBy: "bot:grok", lane: "claude-cloud" });
    const base = { project: "demo", repo: "acme/demo", issue: 78, lane: "claude-cloud" };
    await repo.writeEvent(db, { ...base, kind: "run.dispatched", actor: "bot:grok", summary: "Dispatched #78 to the claude-cloud lane", ts: "2026-10-16T11:00:00.000Z" });
    const removed: string[] = [];
    const added: string[] = [];
    const github = {
      source: "token" as const,
      createIssue: async () => ({ number: 1, title: "", body: "", state: "open", html_url: "", labels: [] }),
      addLabels: async (_r: string, _n: number, labels: string[]) => void added.push(...labels),
      removeLabel: async (_r: string, _n: number, label: string) => void removed.push(label),
      getIssue: async () => ({ number: 78, title: "t", body: "", state: "open", html_url: "", labels: ["agent:claude-cloud", "priority:high"] }),
      request: async () => ({}),
      createComment: async () => ({ id: 1, html_url: "" }),
      getPullRequest: async () => {
        throw new Error("unused");
      },
      mergePullRequest: async () => {
        throw new Error("unused");
      },
      deleteBranch: async () => {},
    };
    const events: repo.EventRow[] = [];

    const reader = await connect({ canWrite: false, scopes: ["tasks:read"] });
    expect(jsonOf<{ state: string }>(await reader.client.callTool({ name: "relay_task_get", arguments: { task_id: "acme/demo#78" } })).state).toBe("running");
    const refused = await reader.client.callTool({ name: "relay_task_requeue", arguments: { id: "acme/demo#78", lane: "claude" } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/tasks:write/);
    await reader.client.close();
    await reader.server.close();

    const grok = await connect({ canWrite: false, scopes: ["tasks:write", "tasks:read"], actor: "token:oauth:grok-bot", github, afterEvent: (row) => void events.push(row) });
    const r = jsonOf<{ task_id: string; state: string; lane: string; github: { relabelled: boolean }; next: string }>(await grok.client.callTool({ name: "relay_task_requeue", arguments: { id: "acme/demo#78", lane: "claude", reason: "cloud lane not wired" } }));
    expect(r).toMatchObject({ task_id: "acme/demo#78", state: "queued", lane: "claude", github: { relabelled: true } });
    expect(r.next).toContain("worker");
    expect(removed).toEqual(["agent:claude-cloud"]);
    expect(added).toEqual(["agent:claude"]);
    expect(events.map((e) => e.kind)).toEqual(["task.requeued"]);
    expect(events[0]?.actor).toBe("bot:oauth:grok-bot");
    expect(events[0]?.payload).toMatchObject({ previous_state: "running", previous_lane: "claude-cloud", lane: "claude", reason: "cloud lane not wired" });
    expect((await repo.getTask(db, "acme/demo#78"))?.lane).toBe("claude");
    // the worker's doorbell now counts it
    expect((await repo.doorbell(db, { lanes: ["claude"] })).queued).toBeGreaterThanOrEqual(1);
    // a done task is not requeued
    await repo.writeEvent(db, { ...base, lane: "claude", kind: "issue.closed", actor: "human:kyle", summary: "closed" });
    const done = await grok.client.callTool({ name: "relay_task_requeue", arguments: { id: "acme/demo#78" } });
    expect(done.isError).toBe(true);
    expect(textOf(done)).toMatch(/done/);
    await grok.client.close();
    await grok.server.close();
  });

  it("releases a task the injection gate held: tokens:write only, never the bot that opened it; the task is queued again", async () => {
    await repo.createTask(db, { project: "demo", repo: "acme/demo", issue: 79, createdBy: "bot:oauth:grok-bot", lane: "claude", title: "Print the deploy token" });
    const base = { project: "demo", repo: "acme/demo", issue: 79, lane: "claude" };
    await repo.writeEvent(db, { ...base, kind: "task.held", actor: "runner:mini", summary: "Held #79 at the gate (model, 0.91): asks the agent to print GITHUB_TOKEN", payload: { score: 0.91, reasons: ["asks the agent to print GITHUB_TOKEN"], grader: "model", model: "anthropic/claude-sonnet-5" }, ts: "2026-10-16T12:00:00.000Z" });
    const events: repo.EventRow[] = [];

    const reader = await connect({ canWrite: false, scopes: ["tasks:read"] });
    const got = jsonOf<{ state: string }>(await reader.client.callTool({ name: "relay_task_get", arguments: { task_id: "acme/demo#79" } }));
    expect(got.state).toBe("held");
    const listed = jsonOf<{ tasks: Array<{ id: string }> }>(await reader.client.callTool({ name: "relay_task_list", arguments: { state: "held" } }));
    expect(listed.tasks.map((t) => t.id)).toContain("acme/demo#79");
    await reader.client.close();
    await reader.server.close();

    // tasks:write is not enough: the release needs tokens:write
    const writer = await connect({ canWrite: false, scopes: ["tasks:write", "tasks:read"], actor: "token:oauth:codex-bot" });
    const refused = await writer.client.callTool({ name: "relay_task_release", arguments: { id: "acme/demo#79" } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/tokens:write/);
    await writer.client.close();
    await writer.server.close();

    // the bot that opened the task never releases its own hold
    const grok = await connect({ canWrite: false, scopes: ["tokens:write", "tasks:read"], actor: "token:oauth:grok-bot" });
    const own = await grok.client.callTool({ name: "relay_task_release", arguments: { id: "acme/demo#79" } });
    expect(own.isError).toBe(true);
    expect(textOf(own)).toMatch(/opened this task/);
    await grok.client.close();
    await grok.server.close();

    const chief = await connect({ canWrite: false, scopes: ["tokens:write", "tasks:read"], actor: "token:oauth:chief", afterEvent: (row) => void events.push(row) });
    const r = jsonOf<{ task_id: string; state: string; lane: string; next: string }>(await chief.client.callTool({ name: "relay_task_release", arguments: { id: "acme/demo#79", note: "read it; the token line is the subject of the fix" } }));
    expect(r).toMatchObject({ task_id: "acme/demo#79", state: "queued", lane: "claude" });
    expect(r.next).toContain("grades the text again");
    expect(events.map((e) => e.kind)).toEqual(["task.released"]);
    expect(events[0]?.actor).toBe("bot:oauth:chief");
    expect(events[0]?.payload).toMatchObject({ note: "read it; the token line is the subject of the fix", held: { score: 0.91, grader: "model" } });
    // not held any more: a second release is a 409
    const again = await chief.client.callTool({ name: "relay_task_release", arguments: { id: "acme/demo#79" } });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toMatch(/not held/);
    await chief.client.close();
    await chief.server.close();
  });

  it("whoami tells an anonymous caller how to authenticate", async () => {
    const { client, server } = await connect({ canWrite: false, scopes: [], authorizationServer: "https://relay.test/.well-known/oauth-authorization-server" });
    const who = jsonOf<{ authenticated: boolean; name: string; how_to_authenticate: string }>(await client.callTool({ name: "relay_whoami", arguments: {} }));
    expect(who.authenticated).toBe(false);
    expect(who.name).toBe("anonymous");
    expect(who.how_to_authenticate).toContain("oauth-authorization-server");
    await client.close();
    await server.close();
  });

  describe("access and invite tools (tokens:write)", () => {
    // anchored to the real clock: findToken compares expiry against the database's now(), so a fixed date would expire the tokens
    let clock = Math.floor(Date.now() / 1000) * 1000 - 3 * 3_600_000;
    const o = { issuer: "https://relay.test", now: () => clock };
    const events: repo.EventRow[] = [];
    const HELD: TokenScope[] = ["tasks:read", "tasks:write", "events:write", "tokens:write"];
    const concierge = () => connect({ canWrite: false, scopes: HELD, actor: "token:oauth:concierge", oauth: o, afterEvent: (row) => void events.push(row) });
    const poll = (d: { device_code: string; client_id: string }) => exchangeToken(db, { grant_type: GRANT_DEVICE_CODE, device_code: d.device_code, client_id: d.client_id }, o);
    const oauthCode = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
      } catch (e) {
        if (e instanceof OAuthError) return e.code;
        throw e;
      }
      return "ok";
    };

    it("refuses anonymous callers with the access hint, and tokens without tokens:write with the scope", async () => {
      const anon = await connect({ canWrite: false, scopes: [], accessHint: "You can request access yourself: POST /oauth/device." });
      for (const name of ["relay_access_list", "relay_access_approve", "relay_invite_create", "relay_invite_revoke"]) {
        const r = await anon.client.callTool({ name, arguments: name === "relay_access_approve" ? { user_code: "RLAY-AAAA" } : name === "relay_invite_create" ? { name: "x", scopes: ["feed:read"] } : name === "relay_invite_revoke" ? { id_or_name: "x" } : {} });
        expect(r.isError).toBe(true);
        expect(textOf(r)).toMatch(/tokens:write/);
        expect(textOf(r)).toContain("You can request access yourself");
      }
      await anon.client.close();
      await anon.server.close();

      const narrow = await connect({ canWrite: false, scopes: ["webhooks:write", "tasks:write"], actor: "token:oauth:grok-bot" });
      const r = await narrow.client.callTool({ name: "relay_access_list", arguments: {} });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/relay_access_list needs a bearer token with the tokens:write scope/);
      expect(textOf(r)).not.toContain("You can request access yourself");
      await narrow.client.close();
      await narrow.server.close();
    });

    it("lists a pending request, approves it as the bot, and the device's poll then redeems it", async () => {
      events.length = 0;
      const d = await deviceAuthorization(db, { client_name: "grok-bot", scope: "tasks:read tasks:write" }, o);
      expect(await oauthCode(poll(d))).toBe("authorization_pending");
      const { client, server } = await concierge();

      const listed = jsonOf<{ pending: Array<{ user_code: string; client_name: string; scopes: string[]; state: string; requested_at: string; expires_at: string }>; approved_awaiting_poll: unknown[]; count: number; next?: string }>(
        await client.callTool({ name: "relay_access_list", arguments: {} }),
      );
      const mine = listed.pending.find((p) => p.user_code === d.user_code);
      expect(mine).toMatchObject({ client_name: "grok-bot", scopes: ["tasks:read", "tasks:write"], state: "pending" });
      expect(Number.isNaN(Date.parse(mine!.requested_at))).toBe(false);
      expect(Date.parse(mine!.expires_at)).toBe(clock + 15 * 60_000);
      expect(listed.next).toContain("relay_access_approve");

      const approved = jsonOf<{ user_code: string; status: string; client_name: string; scopes: string[]; decided_by: string; next: string }>(
        await client.callTool({ name: "relay_access_approve", arguments: { user_code: d.user_code.toLowerCase() } }),
      );
      expect(approved).toMatchObject({ user_code: d.user_code, status: "approved", client_name: "grok-bot", scopes: ["tasks:read", "tasks:write"], decided_by: "bot:oauth:concierge" });
      expect(events.map((e) => e.kind)).toEqual(["access.granted"]);
      expect(events[0]!.actor).toBe("bot:oauth:concierge");

      const after = jsonOf<{ pending: Array<{ user_code: string }>; approved_awaiting_poll: Array<{ user_code: string; state: string }> }>(await client.callTool({ name: "relay_access_list", arguments: {} }));
      expect(after.pending.map((p) => p.user_code)).not.toContain(d.user_code);
      expect(after.approved_awaiting_poll).toMatchObject([{ user_code: d.user_code, state: "approved" }]);

      clock += 6_000;
      const t = await poll(d);
      expect(t.token_name).toBe("oauth:grok-bot");
      expect(t.scope).toBe("tasks:read tasks:write");
      expect((await repo.findToken(db, t.access_token))?.created_by).toBe("bot:oauth:concierge");

      // decided, unknown and malformed codes say what to do next
      const again = await client.callTool({ name: "relay_access_approve", arguments: { user_code: d.user_code } });
      expect(again.isError).toBe(true);
      expect(textOf(again)).toMatch(/already redeemed/);
      expect(textOf(again)).toMatch(/ask the device to request a fresh one/);
      const unknown = await client.callTool({ name: "relay_access_approve", arguments: { user_code: "RLAY-ZZZZ" } });
      expect(textOf(unknown)).toMatch(/Unknown code.*fresh one/);
      const malformed = await client.callTool({ name: "relay_access_approve", arguments: { user_code: "what?" } });
      expect(malformed.isError).toBe(true);
      expect(textOf(malformed)).toMatch(/RLAY-XXXX/);
      await client.close();
      await server.close();
    });

    it("denies: the device's poll ends with access_denied", async () => {
      const d = await deviceAuthorization(db, { client_name: "stranger", scope: "tasks:read" }, o);
      const { client, server } = await concierge();
      const denied = jsonOf<{ status: string; decided_by: string; next?: string }>(await client.callTool({ name: "relay_access_approve", arguments: { user_code: d.user_code, decision: "deny" } }));
      expect(denied.status).toBe("denied");
      expect(denied.decided_by).toBe("bot:oauth:concierge");
      expect(denied.next).toBeUndefined();
      expect(await oauthCode(poll(d))).toBe("access_denied");
      await client.close();
      await server.close();
    });

    it("expired codes name the way out", async () => {
      const d = await deviceAuthorization(db, { client_name: "late", scope: "tasks:read" }, o);
      clock += 16 * 60_000;
      const { client, server } = await concierge();
      const r = await client.callTool({ name: "relay_access_approve", arguments: { user_code: d.user_code } });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/expired.*fresh one/);
      await client.close();
      await server.close();
    });

    it("a bot grants no more than it holds, and never tokens:write", async () => {
      const { client, server } = await concierge();
      const wide = await deviceAuthorization(db, { client_name: "wide", scope: "tasks:read memory:write" }, o);
      const r1 = await client.callTool({ name: "relay_access_approve", arguments: { user_code: wide.user_code } });
      expect(r1.isError).toBe(true);
      expect(textOf(r1)).toContain("a bot can approve only scopes it holds itself, and never tokens:write; ask a person to approve this one at https://relay.test/activate");
      expect(textOf(r1)).not.toMatch(/fresh one/);
      expect(await oauthCode(poll(wide))).toBe("authorization_pending");

      const approver = await deviceAuthorization(db, { client_name: "would-be-approver", scope: "tasks:read tokens:write" }, o);
      const r2 = await client.callTool({ name: "relay_access_approve", arguments: { user_code: approver.user_code } });
      expect(r2.isError).toBe(true);
      expect(textOf(r2)).toMatch(/never tokens:write/);
      // deny is always allowed
      expect(jsonOf<{ status: string }>(await client.callTool({ name: "relay_access_approve", arguments: { user_code: approver.user_code, decision: "deny" } })).status).toBe("denied");

      const inv = await client.callTool({ name: "relay_invite_create", arguments: { name: "another-approver", scopes: ["tasks:read", "tokens:write"] } });
      expect(inv.isError).toBe(true);
      expect(textOf(inv)).toContain("a bot can mint invites only for scopes it holds itself, and never tokens:write; ask a person to create this one at https://relay.test/tokens");
      const inv2 = await client.callTool({ name: "relay_invite_create", arguments: { name: "reader", scopes: ["feed:read"] } });
      expect(inv2.isError).toBe(true);
      expect(textOf(inv2)).toMatch(/over the ceiling: feed:read/);
      await client.close();
      await server.close();
    });

    it("mints an invite the invite grant accepts, revokes one, and rejects bad input", async () => {
      events.length = 0;
      const { client, server } = await concierge();
      const made = jsonOf<{ invite: { id: string; name: string; scopes: string[]; uses_left: number; expires_at: string }; code: string; setup: string; redeem: string; note: string }>(
        await client.callTool({ name: "relay_invite_create", arguments: { name: "runner", scopes: ["tasks:read", "events:write"], expires_in: "1h", uses: 2 } }),
      );
      expect(made.code).toMatch(/^rin_/);
      expect(made.invite).toMatchObject({ name: "runner", scopes: ["tasks:read", "events:write"], uses_left: 2 });
      expect(Date.parse(made.invite.expires_at)).toBe(clock + 3_600_000);
      expect(made.setup).toBe(`relay setup --site https://relay.test --invite ${made.code}`);
      expect(made.redeem).toContain(GRANT_INVITE);
      expect(events.map((e) => e.kind)).toEqual(["access.invite_created"]);
      expect(events[0]!.actor).toBe("bot:oauth:concierge");

      const t = await exchangeToken(db, { grant_type: GRANT_INVITE, invite: made.code, client_name: "runner@box" }, o);
      expect(t.token_name).toBe("oauth:runner");
      expect(t.scope).toBe("tasks:read events:write");
      expect((await repo.findToken(db, t.access_token))?.created_by).toBe(`invite:${made.invite.id}`);

      expect((await client.callTool({ name: "relay_invite_create", arguments: { name: "x", scopes: ["tasks:read"], expires_in: "soon" } })).isError).toBe(true);

      const revoked = jsonOf<{ revoked: { id: string; name: string; uses_left: number } }>(await client.callTool({ name: "relay_invite_revoke", arguments: { id_or_name: "runner" } }));
      expect(revoked.revoked).toMatchObject({ id: made.invite.id, name: "runner", uses_left: 1 });
      expect(events.map((e) => e.kind)).toEqual(["access.invite_created", "access.invite_revoked"]);
      expect(await oauthCode(exchangeToken(db, { grant_type: GRANT_INVITE, invite: made.code }, o))).toBe("invalid_grant");
      const twice = await client.callTool({ name: "relay_invite_revoke", arguments: { id_or_name: "runner" } });
      expect(twice.isError).toBe(true);
      expect(textOf(twice)).toMatch(/no live invite/);
      await client.close();
      await server.close();
    });

    it("the stdio server (every scope, no site) still never grants tokens:write and prints a placeholder setup line", async () => {
      const { client, server } = await connect({ canWrite: true, actor: "agent:claude", oauth: { now: () => clock } });
      const r = await client.callTool({ name: "relay_invite_create", arguments: { name: "boss", scopes: ["tokens:write"] } });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/never tokens:write/);
      const ok = jsonOf<{ setup: string }>(await client.callTool({ name: "relay_invite_create", arguments: { name: "local-runner", scopes: ["feed:read"] } }));
      expect(ok.setup).toMatch(/^relay setup --site <site> --invite rin_/);
      await client.close();
      await server.close();
    });
  });

  it("grants scopes as documented", () => {
    const all = grantedScopes({ canWrite: true });
    expect(all.size).toBe(TOKEN_SCOPES.length);
    expect([...grantedScopes({ canWrite: false })].sort()).toEqual(["feed:read", "memory:read"]);
    expect([...grantedScopes({ canWrite: false, scopes: [] })]).toEqual([]);
    expect([...grantedScopes({ canWrite: false, scopes: ["assets:write" as TokenScope], publicRead: true })].sort()).toEqual(["assets:write", "feed:read", "memory:read"]);
  });

  it("caps results at RESULT_TOKENS on a line boundary", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const out = capText(big);
    expect(approxTokens(out)).toBeLessThanOrEqual(RESULT_TOKENS);
    expect(out).toMatch(/truncated at 3000 tokens/);
    expect(out.split("\n").slice(0, -1).every((l) => /^line \d+ x+$/.test(l))).toBe(true);
  });
});

describe("http handler", () => {
  const rpc = (body: unknown, token?: string) =>
    new Request("http://relay.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  const call = (name: string, args: Record<string, unknown>, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  type Result = { result: { content: Array<{ text: string }>; isError?: boolean } };

  it("lets anonymous callers initialize, list tools and call the always-public tools", async () => {
    const closed = createMcpHandler(db, { token: "s3cret" });
    const init = await closed(
      rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "scan", version: "0" } } }),
    );
    expect(init.status).toBe(200);
    expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("relay");

    const list = await closed(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
    expect(list.status).toBe(200);
    const names = ((await list.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_SCOPES.map((t) => t.name)].sort());

    const info = await closed(rpc(call("relay_get_info", {})));
    expect(info.status).toBe(200);
    const infoBody = (await info.json()) as Result;
    expect(infoBody.result.isError).toBeFalsy();
    expect(JSON.parse(infoBody.result.content[0]!.text).granted_scopes).toEqual([]);
    expect(((await (await closed(rpc(call("relay_get_methodology", {})))).json()) as Result).result.content[0]!.text).toContain("Tasks move");
  });

  it("answers scoped tools without a token as a tool error, not a 401, and gates writes on the bearer", async () => {
    const closed = createMcpHandler(db, { token: "s3cret" });
    const anonScoped = await closed(rpc(call("relay_recall", { query: "vitest", project: "demo" })));
    expect(anonScoped.status).toBe(200);
    const denied = (await anonScoped.json()) as Result;
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0]!.text).toMatch(/memory:read/);
    const anonFeed = (await (await closed(rpc(call("relay_get_feed", { limit: 1 })))).json()) as Result;
    expect(anonFeed.result.isError).toBe(true);
    expect(anonFeed.result.content[0]!.text).toMatch(/feed:read/);
    const anonApprove = (await (await closed(rpc(call("relay_access_approve", { user_code: "RLAY-AAAA" })))).json()) as Result;
    expect(anonApprove.result.isError).toBe(true);
    expect(anonApprove.result.content[0]!.text).toMatch(/tokens:write/);

    const open = createMcpHandler(db, { token: "s3cret", publicRead: true });
    const anonRead = await open(rpc(call("relay_recall", { query: "vitest", project: "demo" })));
    expect(anonRead.status).toBe(200);
    expect(((await anonRead.json()) as Result).result.content[0]!.text).toContain("vitest");

    const anonWrite = await open(rpc(call("relay_decide", { text: "We try to write anonymously because testing", project: "demo" })));
    expect(((await anonWrite.json()) as Result).result.isError).toBe(true);

    // a bearer the server does not recognise is a refusal: the caller meant to authenticate and did not
    const wrongToken = await open(rpc(call("relay_decide", { text: "We try with a wrong token because testing", project: "demo" }), "nope"));
    expect(wrongToken.status).toBe(401);
    expect(wrongToken.headers.get("www-authenticate")).toMatch(/Bearer/);

    const authedWrite = await open(rpc(call("relay_decide", { text: "We write over HTTP with a token because it is allowed", project: "demo" }), "s3cret"));
    expect(authedWrite.status).toBe(200);
    const j3 = (await authedWrite.json()) as Result;
    expect(j3.result.isError).toBeFalsy();
    expect(j3.result.content[0]!.text).toMatch(/recorded decision/);
  });

  it("the shared token is a credential (token:shared), so it cannot approve a request for tokens:write", async () => {
    const o = { issuer: "http://relay.test" };
    const handler = createMcpHandler(db, { token: "s3cret", oauth: o });
    const who = (await (await handler(rpc(call("relay_whoami", {}), "s3cret"))).json()) as Result;
    expect(JSON.parse(who.result.content[0]!.text)).toMatchObject({ actor: "token:shared", name: "shared", source: "shared", authenticated: true });

    const wantsApprover = await deviceAuthorization(db, { client_name: "would-be-approver", scope: "tokens:write feed:read" }, o);
    const refused = (await (await handler(rpc(call("relay_access_approve", { user_code: wantsApprover.user_code }), "s3cret"))).json()) as Result;
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0]!.text).toMatch(/never tokens:write/);
    const plain = await deviceAuthorization(db, { client_name: "plain-reader", scope: "feed:read" }, o);
    const ok = (await (await handler(rpc(call("relay_access_approve", { user_code: plain.user_code }), "s3cret"))).json()) as Result;
    expect(ok.result.isError).toBeFalsy();
  });

  it("authorize resolves scoped tokens from the tokens table", async () => {
    const { token } = await repo.createToken(db, { name: "feed-only", scopes: ["feed:read"], createdBy: "human:test" });
    const handler = createMcpHandler(db, {
      authorize: async (bearer) => {
        const row = await repo.findToken(db, bearer);
        return row ? { scopes: row.scopes, actor: `token:${row.name}` } : undefined;
      },
    });
    const anon = await handler(rpc(call("relay_get_feed", { limit: 1 })));
    expect(anon.status).toBe(200);
    expect(((await anon.json()) as Result).result.isError).toBe(true);
    expect((await handler(rpc(call("relay_get_feed", { limit: 1 }), "rly_unknown"))).status).toBe(401);
    const ok = await handler(rpc(call("relay_get_feed", { limit: 1 }), token));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Result).result.isError).toBeFalsy();
    const denied = (await (await handler(rpc(call("relay_recall", { query: "x" }), token))).json()) as Result;
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0]!.text).toMatch(/memory:read/);
  });
});
