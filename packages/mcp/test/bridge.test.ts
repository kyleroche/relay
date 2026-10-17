/**
 * Site mode for the stdio server. Two layers: `createSiteBridge` against `createMcpHandler` used as `fetch` (the
 * pass-through, scope refusals, the 401 renewal, protocol headers), and the real `relay-mcp` process spawned with a
 * temp RELAY_HOME whose config.json and credentials.json point it at a local HTTP server that serves
 * `createMcpHandler` at /mcp and a stub token endpoint at /oauth/token: initialize, tools/list and tools/call round
 * trip through stdio, an expired token is refreshed once before the first call, and a token the site refuses is
 * replaced by the one another process wrote to disk.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { openDb, migrate, repo, TOKEN_SCOPES, type Db, type TokenScope } from "@relay/core";
import { createMcpHandler, type Grant } from "../src/http.ts";
import { TOOL_SCOPES } from "../src/server.ts";
import { BRIDGE_UNAUTHORIZED, BRIDGE_UNREACHABLE, createSiteBridge, listSiteTools, parseMcpBody, tokenLabel, type BridgeAuth } from "../src/bridge.ts";

const ALL = "rly_all";
const READER = "rly_reader";
const grants: Record<string, Grant> = {
  [ALL]: { scopes: [...TOKEN_SCOPES], actor: "token:oauth:test-machine", name: "oauth:test-machine", source: "db" },
  [READER]: { scopes: ["feed:read", "memory:read"] as TokenScope[], actor: "token:reader", name: "reader", source: "db" },
};

let db: Db;
beforeAll(async () => {
  db = await openDb({ file: ":memory:" });
  await migrate(db);
  await repo.upsertProject(db, { slug: "mission-learn", repo: "acme/mission-learn", path: "/tmp/mission-learn", stack: "ts" });
});
afterAll(async () => {
  await db.close();
});

const init = (id = 1): JSONRPCMessage => ({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bridge-test", version: "0" } } });
const list = (id = 2): JSONRPCMessage => ({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
const call = (name: string, args: Record<string, unknown>, id = 3): JSONRPCMessage => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
type ToolAnswer = { id: number; result?: { content: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string }>; serverInfo?: { name: string }; protocolVersion?: string }; error?: { code: number; message: string; data?: unknown } };
const first = (out: JSONRPCMessage[]): ToolAnswer => out[0] as unknown as ToolAnswer;
const textOf = (a: ToolAnswer): string => (a.result?.content ?? []).map((c) => c.text).join("\n");

/** The hosted handler as a `fetch`, recording the headers each request carried. */
function siteFetch(opts: { publicRead?: boolean } = {}) {
  const handler = createMcpHandler(db, { authorize: async (b) => grants[b], publicRead: !!opts.publicRead });
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const f: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    seen.push({ url, headers });
    return handler(new Request(url, { method: init?.method ?? "POST", headers, body: init?.body as string }));
  };
  return { fetch: f, seen };
}

const staticAuth = (token: string, renew: BridgeAuth["renew"] = async () => undefined): BridgeAuth => ({ token: async () => token, renew });

describe("site bridge: pass-through to the hosted /mcp", () => {
  it("forwards initialize, tools/list and tools/call and returns the site's answers unchanged", async () => {
    const site = siteFetch();
    const bridge = createSiteBridge({ site: "https://relay.test/", auth: staticAuth(ALL), fetch: site.fetch });
    expect(bridge.site).toBe("https://relay.test");

    const hello = first(await bridge.forward(init()));
    expect(hello.id).toBe(1);
    expect(hello.result?.serverInfo?.name).toBe("relay");
    expect(hello.result?.protocolVersion).toBe("2025-06-18");

    const tools = first(await bridge.forward(list()));
    expect(tools.id).toBe(2);
    expect((tools.result?.tools ?? []).map((t) => t.name).sort()).toEqual([...TOOL_SCOPES.map((t) => t.name)].sort());

    // the project registered on the site answers here, which is the whole point: no local database is consulted
    const project = first(await bridge.forward(call("relay_project", { slug: "mission-learn" })));
    expect(project.result?.isError).toBeFalsy();
    expect(textOf(project)).toContain("slug: mission-learn");

    const decided = first(await bridge.forward(call("relay_decide", { project: "mission-learn", text: "Briefs come from the site", source: "bridge-test" }, 4)));
    expect(decided.result?.isError).toBeFalsy();
    expect(textOf(decided)).toMatch(/#\d+/);
    expect((await repo.listDecisions(db, "mission-learn", { current: true })).some((d) => d.text === "Briefs come from the site")).toBe(true);

    // every request carried the bearer; the version negotiated at initialize travels on the later ones
    expect(site.seen.every((r) => r.url === "https://relay.test/mcp" && r.headers.authorization === `Bearer ${ALL}`)).toBe(true);
    expect(site.seen[0]!.headers["mcp-protocol-version"]).toBeUndefined();
    expect(site.seen.slice(1).every((r) => r.headers["mcp-protocol-version"] === "2025-06-18")).toBe(true);
  });

  it("passes the site's scope refusal through as the tool error it is", async () => {
    const site = siteFetch();
    const bridge = createSiteBridge({ site: "https://relay.test", auth: staticAuth(READER), fetch: site.fetch });
    const denied = first(await bridge.forward(call("relay_decide", { project: "mission-learn", text: "A reader must not be able to write this", source: "bridge-test" })));
    expect(denied.error).toBeUndefined();
    expect(denied.result?.isError).toBe(true);
    expect(textOf(denied)).toMatch(/memory:write/);
    const ok = first(await bridge.forward(call("relay_recall", { project: "mission-learn", query: "briefs" }, 4)));
    expect(ok.result?.isError).toBeFalsy();
  });

  it("answers nothing for a notification and relays the site's protocol errors", async () => {
    const site = siteFetch();
    const bridge = createSiteBridge({ site: "https://relay.test", auth: staticAuth(ALL), fetch: site.fetch });
    expect(await bridge.forward({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual([]);
    const unknown = first(await bridge.forward({ jsonrpc: "2.0", id: 9, method: "prompts/list", params: {} }));
    expect(unknown.id).toBe(9);
    expect(unknown.error?.code).toBe(-32601);
  });

  it("renews the token once when the site answers 401, then retries the same message", async () => {
    const site = siteFetch();
    const renewed: string[] = [];
    const auth: BridgeAuth = {
      token: async () => "rly_revoked",
      renew: async (rejected) => {
        renewed.push(rejected);
        return ALL;
      },
    };
    const lines: string[] = [];
    const bridge = createSiteBridge({ site: "https://relay.test", auth, fetch: site.fetch, log: (l) => lines.push(l) });
    const answer = first(await bridge.forward(call("relay_project", { slug: "mission-learn" })));
    expect(answer.result?.isError).toBeFalsy();
    expect(renewed).toEqual(["rly_revoked"]);
    expect(site.seen.map((r) => r.headers.authorization)).toEqual(["Bearer rly_revoked", `Bearer ${ALL}`]);
    expect(lines.some((l) => /401/.test(l) && /renewed/.test(l))).toBe(true);
  });

  it("turns a 401 nobody can renew into one JSON-RPC error carrying the site's message", async () => {
    const site = siteFetch();
    const bridge = createSiteBridge({ site: "https://relay.test", auth: staticAuth("rly_revoked", async () => Promise.reject(new Error("the refresh failed (invalid_grant)"))), fetch: site.fetch });
    const answer = first(await bridge.forward(call("relay_project", { slug: "mission-learn" }, 7)));
    expect(answer.id).toBe(7);
    expect(answer.error?.code).toBe(BRIDGE_UNAUTHORIZED);
    expect(answer.error?.message).toMatch(/unauthorized/);
    expect(answer.error?.message).toMatch(/invalid_grant/);
    expect(site.seen).toHaveLength(1);
  });

  it("reports an unreachable site as a JSON-RPC error instead of dying", async () => {
    const bridge = createSiteBridge({ site: "https://relay.test", auth: staticAuth(ALL), fetch: async () => Promise.reject(new Error("ECONNREFUSED")) });
    const answer = first(await bridge.forward(list(5)));
    expect(answer.id).toBe(5);
    expect(answer.error?.code).toBe(BRIDGE_UNREACHABLE);
    expect(answer.error?.message).toMatch(/cannot reach https:\/\/relay.test\/mcp: ECONNREFUSED/);
  });

  it("reads JSON and SSE bodies alike", () => {
    expect(parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{}}', "application/json")).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    expect(parseMcpBody('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/x"}\n\n', "text/event-stream")).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", method: "notifications/x" },
    ]);
    expect(parseMcpBody("", "application/json")).toEqual([]);
  });

  it("listSiteTools is the doctor's cheap probe: the names on success, the site's message on refusal", async () => {
    const site = siteFetch();
    const { tools } = await listSiteTools({ site: "https://relay.test", token: ALL, fetch: site.fetch });
    expect(tools.sort()).toEqual([...TOOL_SCOPES.map((t) => t.name)].sort());
    await expect(listSiteTools({ site: "https://relay.test", token: "rly_nobody", fetch: site.fetch })).rejects.toThrow(/unauthorized/);
  });

  it("names the credential without printing it", () => {
    expect(tokenLabel({ siteTokenName: "oauth:relay-cli@mac" })).toBe("oauth:relay-cli@mac");
    expect(tokenLabel({ siteTokenSource: "manual" })).toBe("a pasted token");
    expect(tokenLabel({ siteTokenSource: "env" })).toBe("RELAY_TOKEN");
    expect(tokenLabel({ siteTokenSource: "device" })).toBe("an unnamed device-flow token");
  });
});

/** A local "site": createMcpHandler at /mcp and a stub refresh grant at /oauth/token, on a Node http server. */
async function startSite() {
  const handler = createMcpHandler(db, { authorize: async (b) => grants[b] });
  const refreshes: string[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    if (req.url === "/oauth/token") {
      const form = new URLSearchParams(body);
      refreshes.push(String(form.get("refresh_token")));
      if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== "rly_refresh") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant", error_description: "unknown refresh token" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: ALL, token_type: "Bearer", expires_in: 3600, refresh_token: "rly_refresh_2", token_name: "oauth:test-machine", scope: TOKEN_SCOPES.join(" ") }));
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    const r = await handler(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: req.method === "POST" ? body : undefined }));
    res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
    res.end(await r.text());
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, refreshes, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

const BIN = resolve(import.meta.dirname, "..", "bin", "relay-mcp.mjs");

function writeHome(home: string, site: string, creds: Record<string, unknown>) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ site }, null, 2));
  writeFileSync(join(home, "credentials.json"), JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/** Spawn the real stdio server with RELAY_HOME at `home`; returns the connected client and the stderr collected so far. */
async function spawnRelayMcp(home: string) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "RELAY_SITE" && k !== "RELAY_TOKEN" && k !== "DATABASE_URL") env[k] = v;
  env.RELAY_HOME = home;
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env, stderr: "pipe" });
  const stderr: string[] = [];
  const client = new Client({ name: "bridge-e2e", version: "0" });
  await client.connect(transport);
  transport.stderr?.on("data", (c: Buffer) => stderr.push(c.toString("utf8")));
  const errText = async () => {
    await new Promise((r) => setTimeout(r, 50));
    return stderr.join("");
  };
  return { client, transport, errText };
}

describe("relay-mcp in site mode (spawned)", () => {
  let site: Awaited<ReturnType<typeof startSite>>;
  let tmp: string;
  beforeAll(async () => {
    site = await startSite();
    tmp = mkdtempSync(join(tmpdir(), "relay-mcp-site-"));
  });
  afterAll(async () => {
    await site.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("forwards initialize, tools/list and tools/call over stdio to the site and says so on stderr", async () => {
    const home = join(tmp, "valid");
    writeHome(home, site.url, { token: ALL, refresh_token: "rly_refresh", expires_at: new Date(Date.now() + 3600_000).toISOString(), source: "device", token_name: "oauth:test-machine" });
    const { client, errText } = await spawnRelayMcp(home);
    try {
      expect(client.getServerVersion()?.name).toBe("relay");
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual([...TOOL_SCOPES.map((t) => t.name)].sort());
      const project = await client.callTool({ name: "relay_project", arguments: { slug: "mission-learn" } });
      expect(project.isError).toBeFalsy();
      expect((project.content as Array<{ text: string }>)[0]!.text).toContain("slug: mission-learn");
      // the site's own view of the credential, so the answer is the site's and not a local server's
      const who = await client.callTool({ name: "relay_whoami", arguments: {} });
      expect((who.content as Array<{ text: string }>)[0]!.text).toContain("oauth:test-machine");
      expect(await errText()).toContain(`relay-mcp: site mode, forwarding to ${site.url} as oauth:test-machine`);
      expect(site.refreshes).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("refreshes an expired token once through the site's token endpoint before the first call, and stores the new pair", async () => {
    const home = join(tmp, "expired");
    writeHome(home, site.url, { token: "rly_expired", refresh_token: "rly_refresh", expires_at: new Date(Date.now() - 60_000).toISOString(), source: "device", token_name: "oauth:test-machine" });
    const { client } = await spawnRelayMcp(home);
    try {
      const project = await client.callTool({ name: "relay_project", arguments: { slug: "mission-learn" } });
      expect(project.isError).toBeFalsy();
      await client.listTools();
      expect(site.refreshes).toEqual(["rly_refresh"]);
      const saved = JSON.parse(readFileSync(join(home, "credentials.json"), "utf8")) as Record<string, string>;
      expect(saved.token).toBe(ALL);
      expect(saved.refresh_token).toBe("rly_refresh_2");
      expect(saved.token_name).toBe("oauth:test-machine");
    } finally {
      await client.close();
      site.refreshes.length = 0;
    }
  });

  it("passes a refusal through, then picks up the credential another relay process wrote to disk", async () => {
    const home = join(tmp, "rotated");
    // a pasted token (no refresh token, so nothing to renew with) that the site revokes while the server runs
    grants.rly_temp = grants[ALL]!;
    writeHome(home, site.url, { token: "rly_temp", source: "manual" });
    const { client, errText } = await spawnRelayMcp(home);
    try {
      expect((await client.callTool({ name: "relay_project", arguments: { slug: "mission-learn" } })).isError).toBeFalsy();
      delete grants.rly_temp;
      await expect(client.callTool({ name: "relay_project", arguments: { slug: "mission-learn" } })).rejects.toThrow(/unauthorized/);
      expect(await errText()).toContain("refused the token (401)");
      // relay setup --site on this machine stores a good one; the running server uses it on the next message
      writeHome(home, site.url, { token: ALL, source: "manual" });
      const project = await client.callTool({ name: "relay_project", arguments: { slug: "mission-learn" } });
      expect(project.isError).toBeFalsy();
      expect(site.refreshes).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
