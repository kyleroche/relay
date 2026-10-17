import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, migrate, repo, approxTokens, LocalStore, TOKEN_SCOPES, verifyLocalUploadUrl, type Db, type TokenScope } from "@relay/core";
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
      "relay_prefer",
      "relay_project",
      "relay_recall",
      "relay_task_create",
      "relay_task_get",
      "relay_task_list",
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

  it("whoami tells an anonymous caller how to authenticate", async () => {
    const { client, server } = await connect({ canWrite: false, scopes: [], authorizationServer: "https://relay.test/.well-known/oauth-authorization-server" });
    const who = jsonOf<{ authenticated: boolean; name: string; how_to_authenticate: string }>(await client.callTool({ name: "relay_whoami", arguments: {} }));
    expect(who.authenticated).toBe(false);
    expect(who.name).toBe("anonymous");
    expect(who.how_to_authenticate).toContain("oauth-authorization-server");
    await client.close();
    await server.close();
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
