/**
 * The reference worker (examples/worker-agent/loop.mjs) against the in-memory MCP server: the loop the guide
 * describes (docs/WORKER-AGENTS.md) registers, backs off while idle, claims when the doorbell moves, starts,
 * uploads the output through the asset tools, releases finished, and reports offline; a job that throws is a
 * failed run. The clock and the upload are injected, so no timers and no network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, migrate, repo, LocalStore, verifyLocalUploadUrl, type Db, type GitHubClient } from "@relay/core";
import { createRelayServer, type RelayServerOptions } from "../src/server.ts";
import { createLoop, nextInterval, parseResult, DEFAULTS, type Claim } from "../../../examples/worker-agent/loop.mjs";
import { doJob } from "../../../examples/worker-agent/job.mjs";

let db: Db;
let home: string;
let store: LocalStore;
const bodies = new Map<number, string>();
const github: GitHubClient = {
  source: "token",
  createIssue: async () => {
    throw new Error("unused");
  },
  addLabels: async () => {},
  removeLabel: async () => {},
  getIssue: async (_r, n) => ({ number: n, title: `Task ${n}`, body: bodies.get(n) ?? "", state: "open", html_url: `https://github.com/acme/demo/issues/${n}`, labels: ["agent:embroidery"] }),
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

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "relay-worker-agent-"));
  delete process.env.RELAY_ASSET_SIGNING_KEY;
  store = new LocalStore(join(home, "assets"));
  db = await openDb({ file: ":memory:" });
  await migrate(db);
  await repo.upsertProject(db, { slug: "demo", repo: "acme/demo", path: "/tmp/demo", stack: "ts" });
  await repo.setProjectSummary(db, "demo", "Demo makes embroidered badges.", 8);
  await repo.addDecision(db, { project: "demo", text: "Badges are digitized at 130x180 unless the issue says otherwise", source: "human" });
});
afterAll(async () => {
  await db.close();
  rmSync(home, { recursive: true, force: true });
});

async function connect(opts: Partial<RelayServerOptions> = {}) {
  const events: repo.EventRow[] = [];
  const server = createRelayServer(db, {
    canWrite: false,
    scopes: ["work:claim", "assets:write", "assets:read", "memory:read"],
    actor: "token:oauth:example-worker",
    invalidateCache: false,
    assets: { store },
    github,
    afterEvent: (row) => void events.push(row),
    ...opts,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "worker-agent-test", version: "0" });
  await client.connect(clientT);
  const call = async (name: string, args: Record<string, unknown>) => parseResult(await client.callTool({ name, arguments: args }));
  // the "PUT" lands straight in the store, as the web app's upload route would put it
  const put = async (url: string, bytes: Uint8Array, headers: Record<string, string>) => {
    const v = verifyLocalUploadUrl(url, store);
    if (!v.ok) throw new Error(`bad upload url: ${v.reason}`);
    await store.put(v.key, Buffer.from(bytes), { contentType: headers["content-type"] ?? "application/octet-stream" });
  };
  return { client, server, call, put, events, close: async () => (await client.close(), await server.close()) };
}

describe("the example worker loop", () => {
  it("backs off while idle, claims when the doorbell moves, delivers the job and reports offline", async () => {
    const c = await connect();
    let clock = 1_000_000;
    const slept: number[] = [];
    const logs: string[] = [];
    const loop = createLoop({
      call: c.call,
      doJob,
      put: c.put,
      name: "example-mac",
      host: "studio.local",
      lanes: ["embroidery"],
      labels: ["app:example"],
      version: "0.1.0",
      now: () => clock,
      sleep: async (ms) => void slept.push(ms),
      log: (l) => void logs.push(l),
    });

    const reg = await loop.register();
    expect(reg).toMatchObject({ name: "example-mac", lanes: ["embroidery"], labels: ["app:example"], registered: true });
    expect(loop.state.workerId).toBe(reg.worker_id);

    // idle: one doorbell, one heartbeat with the interval, nothing claimed, the tick doubles
    const t1 = await loop.tick();
    expect(t1.claimed).toBe(false);
    expect(t1.bell.queued).toBe(0);
    expect(t1.interval).toBe(15_000);
    const t2 = await loop.tick();
    expect(t2.claimed).toBe(false);
    expect(t2.interval).toBe(30_000);
    const w = (await repo.getWorker(db, reg.worker_id))!;
    expect(w.poll_ms).toBe(15_000);

    // the artwork, then the task: the doorbell moves and the next tick runs the job
    const art = await c.call("relay_asset_request_upload", { project: "demo", filename: "logo.svg" });
    await c.put(art.upload_url, new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), art.headers);
    await c.call("relay_asset_finalize", { key: art.key, project: "demo", title: "Logo" });
    bodies.set(95, `Digitize the logo.\n\n\`\`\`relay-job\ninputs:\n  - asset: ${art.id}\n    as: artwork\nparams: { "hoop": "130x180" }\noutputs: [stitch-file]\n\`\`\`\n`);
    await repo.createTask(db, { project: "demo", repo: "acme/demo", issue: 95, createdBy: "human:kyle", lane: "embroidery", title: "Digitize the logo" });

    clock += 5_000;
    const t3 = await loop.tick();
    expect(t3.claimed).toBe(true);
    expect(t3.result).toMatchObject({ outcome: "finished", state: "review" });
    expect(t3.result!.assets).toHaveLength(1);
    expect(t3.interval).toBe(15_000);

    const task = (await repo.taskView(db, (await repo.getTask(db, "acme/demo#95"))!))!;
    expect(task.state).toBe("review");
    const out = (await repo.getAsset(db, t3.result!.assets[0]!))!;
    expect(out).toMatchObject({ issue: 95, title: "stitch-file", created_by: "bot:oauth:example-worker" });
    const text = (await store.read(out.storage_key)).toString();
    expect(text).toContain("artwork: Logo (image/svg+xml, v1)");
    expect(text).toContain("Badges are digitized at 130x180");
    expect(text).toContain('params: {"hoop":"130x180"}');
    const kinds = c.events.map((e) => e.kind);
    expect(kinds).toEqual(["worker.registered", "worker.online", "run.started", "run.finished"]);
    const finished = c.events.find((e) => e.kind === "run.finished")!;
    expect(finished.actor).toBe("runner:example-mac");
    expect(finished.summary).toContain(`(assets: ${out.id})`);
    expect(logs.some((l) => l.includes("acme/demo#95: finished, now review"))).toBe(true);

    // run(): ticks and sleeps until the signal, then reports offline
    const ctl = new AbortController();
    const loop2 = createLoop({ call: c.call, doJob, put: c.put, name: "example-mac", lanes: ["embroidery"], now: () => clock, sleep: async (ms) => (slept.push(ms), slept.length >= 3 ? ctl.abort() : undefined), log: () => {} });
    await loop2.run({ signal: ctl.signal });
    expect(slept.slice(-3)).toEqual([15_000, 30_000, 60_000]);
    expect(c.events.at(-1)?.kind).toBe("worker.offline");
    await c.close();
  });

  it("a job that throws is a failed run with the message on the card; the lease is released", async () => {
    const c = await connect();
    const loop = createLoop({
      call: c.call,
      put: c.put,
      doJob: async () => {
        throw new Error("the digitizer app did not open");
      },
      name: "example-mac",
      lanes: ["embroidery"],
      sleep: async () => {},
      log: () => {},
    });
    await loop.register();
    bodies.set(96, "Cut the badge, no manifest.");
    await repo.createTask(db, { project: "demo", repo: "acme/demo", issue: 96, createdBy: "human:kyle", lane: "embroidery", title: "Cut the badge" });
    const r = await loop.claimOnce();
    expect(r).toMatchObject({ outcome: "failed", state: "failed", error: "the digitizer app did not open" });
    expect((await repo.liveClaims(db)).map((x) => x.task_id)).not.toContain("acme/demo#96");
    expect(c.events.filter((e) => e.kind === "run.failed")[0]?.summary).toBe("the digitizer app did not open");
    // a manifest that cannot be used never reaches doJob
    bodies.set(97, "```relay-job\ninputs: [01JNOPE]\n```");
    await repo.createTask(db, { project: "demo", repo: "acme/demo", issue: 97, createdBy: "human:kyle", lane: "embroidery" });
    const r2 = await loop.claimOnce();
    expect(r2?.outcome).toBe("failed");
    expect(r2?.error).toMatch(/relay-job block cannot be used: input asset 01JNOPE does not exist/);
    expect(await loop.claimOnce()).toBeNull();
    await c.close();
  });

  it("nextInterval and parseResult", () => {
    expect(nextInterval(15_000, false)).toBe(30_000);
    expect(nextInterval(240_000, false)).toBe(300_000);
    expect(nextInterval(300_000, false)).toBe(300_000);
    expect(nextInterval(300_000, true)).toBe(DEFAULTS.interval);
    expect(parseResult({ content: [{ type: "text", text: "null" }] })).toBeNull();
    expect(parseResult({ content: [{ type: "text", text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(() => parseResult({ isError: true, content: [{ type: "text", text: "relay: x needs work:claim" }] })).toThrow(/work:claim/);
    const claim: Claim | null = null;
    expect(claim).toBeNull();
  });
});
