import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, migrate, repo, approxTokens, type Db } from "@relay/core";
import { createRelayServer, capText, RESULT_TOKENS } from "../src/server.ts";
import { createMcpHandler } from "../src/http.ts";

let db: Db;
beforeAll(async () => {
  db = await openDb({ file: ":memory:" });
  await migrate(db);
  await repo.upsertProject(db, { slug: "demo", repo: "acme/demo", path: "/tmp/demo", stack: "ts" });
  await repo.setProjectSummary(db, "demo", "Demo is a TypeScript service.", 8);
});
afterAll(async () => {
  await db.close();
});

async function connect(canWrite: boolean) {
  const server = createRelayServer(db, { canWrite, actor: "human:test", invalidateCache: false });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return { client, server };
}

const textOf = (r: Awaited<ReturnType<Client["callTool"]>>): string => (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");

describe("relay mcp tools", () => {
  it("lists the seven tools", async () => {
    const { client, server } = await connect(true);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["relay_brief", "relay_decide", "relay_feed", "relay_guidance", "relay_prefer", "relay_project", "relay_recall"]);
    await client.close();
    await server.close();
  });

  it("decide, prefer, recall, brief, project and feed round-trip", async () => {
    const { client, server } = await connect(true);
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

  it("refuses writes on a read-only connection but still reads", async () => {
    const { client, server } = await connect(false);
    const d = await client.callTool({ name: "relay_decide", arguments: { text: "We never do this because read-only", project: "demo" } });
    expect(d.isError).toBe(true);
    expect(textOf(d)).toMatch(/read-only/);
    const r = textOf(await client.callTool({ name: "relay_recall", arguments: { query: "vitest", project: "demo" } }));
    expect(r).toContain("vitest");
    await client.close();
    await server.close();
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
    new Request("http://relay.test/api/memory", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  const call = (name: string, args: Record<string, unknown>, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

  it("401s without a token unless publicRead, and gates writes on the bearer", async () => {
    const closed = createMcpHandler(db, { token: "s3cret" });
    expect((await closed(rpc(call("relay_recall", { query: "vitest", project: "demo" })))).status).toBe(401);

    const open = createMcpHandler(db, { token: "s3cret", publicRead: true });
    const anonRead = await open(rpc(call("relay_recall", { query: "vitest", project: "demo" })));
    expect(anonRead.status).toBe(200);
    const j1 = (await anonRead.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(j1.result.content[0]!.text).toContain("vitest");

    const anonWrite = await open(rpc(call("relay_decide", { text: "We try to write anonymously because testing", project: "demo" })));
    const j2 = (await anonWrite.json()) as { result: { isError?: boolean } };
    expect(j2.result.isError).toBe(true);

    const wrongToken = await open(rpc(call("relay_decide", { text: "We try with a wrong token because testing", project: "demo" }), "nope"));
    expect(((await wrongToken.json()) as { result: { isError?: boolean } }).result.isError).toBe(true);

    const authedWrite = await open(rpc(call("relay_decide", { text: "We write over HTTP with a token because it is allowed", project: "demo" }), "s3cret"));
    expect(authedWrite.status).toBe(200);
    const j3 = (await authedWrite.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(j3.result.isError).toBeFalsy();
    expect(j3.result.content[0]!.text).toMatch(/recorded decision/);
  });
});
