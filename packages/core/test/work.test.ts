/**
 * The scheduler (docs/WORKERS.md): claims are atomic and leased, expired leases re-queue, lane.labels gate claims,
 * task state learns `claimed`, and the server protocol writes the documented events.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, type Db } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import * as repo from "../src/db/repo.ts";
import { deriveTaskStatus, type ClaimLike } from "../src/db/tasks.ts";
import { claimServer, heartbeatServer, registerWorkerServer, releaseServer, startServer, WorkError } from "../src/work/server.ts";
import { servicePlan } from "../src/work/service.ts";

let db: Db;
let n = 0;
const newTask = async (lane: string, project = "demo", repoName = "acme/demo") => {
  n++;
  const { task } = await repo.createTask(db, { project, repo: repoName, issue: n, createdBy: "human:kyle", lane });
  return task;
};

beforeAll(async () => {
  db = await openDb({ file: ":memory:" });
  await migrate(db);
  await repo.upsertProject(db, { slug: "demo", repo: "acme/demo", path: "/tmp/demo" });
  await repo.upsertProject(db, { slug: "gpu", repo: "acme/gpu", path: "/tmp/gpu" });
});
afterAll(async () => {
  await db.close();
});

describe("workers", () => {
  it("registers by name with a stable id and replaces lanes and labels", async () => {
    const a = await repo.registerWorker(db, { name: "mini", host: "mini.local", lanes: ["claude", "codex"], labels: ["xcode"], version: "0.1.0" });
    const b = await repo.registerWorker(db, { name: "mini", host: "mini.local", lanes: ["claude"], labels: [], version: "0.1.1" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.worker.id).toBe(a.worker.id);
    expect(b.worker.lanes).toEqual(["claude"]);
    expect(b.worker.labels).toEqual([]);
    expect(b.worker.version).toBe("0.1.1");
    await expect(repo.registerWorker(db, { name: "bad name!", lanes: [] })).rejects.toThrow(/worker name/);
  });

  it("derives online, idle and offline from last_seen", () => {
    const now = Date.now();
    expect(repo.workerState({ last_seen: new Date(now - 30_000).toISOString(), status: "online" }, now)).toBe("online");
    expect(repo.workerState({ last_seen: new Date(now - 10 * 60_000).toISOString(), status: "online" }, now)).toBe("idle");
    expect(repo.workerState({ last_seen: new Date(now - 2 * 3_600_000).toISOString(), status: "online" }, now)).toBe("offline");
    expect(repo.workerState({ last_seen: new Date(now).toISOString(), status: "offline" }, now)).toBe("offline");
  });
});

describe("claimNext", () => {
  it("claims the oldest queued task for the worker's lanes, once, and skips lanes it does not serve", async () => {
    const { worker: w1 } = await repo.registerWorker(db, { name: "w1", lanes: ["claude"] });
    const { worker: w2 } = await repo.registerWorker(db, { name: "w2", lanes: ["claude", "codex"] });
    const first = await newTask("claude");
    const second = await newTask("claude");
    const codex = await newTask("codex");

    // two workers race for the same queue: each task is handed out exactly once
    const [a, b] = await Promise.all([repo.claimNext(db, { workerId: w1.id, lanes: ["claude"] }), repo.claimNext(db, { workerId: w2.id, lanes: ["claude"] })]);
    const ids = [a?.task.id, b?.task.id].sort();
    expect(ids).toEqual([first.id, second.id].sort());
    expect(a?.task.lane).toBe("claude");

    // nothing left for claude; codex only for the worker that serves it
    expect(await repo.claimNext(db, { workerId: w1.id, lanes: ["claude"] })).toBeUndefined();
    expect(await repo.claimNext(db, { workerId: w1.id, lanes: [] })).toBeUndefined();
    const c = await repo.claimNext(db, { workerId: w2.id, lanes: ["codex"] });
    expect(c?.task.id).toBe(codex.id);
    expect(new Date(c!.claim.lease_until).getTime() - new Date(c!.claim.claimed_at).getTime()).toBe(repo.LEASE_MS);

    // the derived state of a claimed task is `claimed`, attributed to the worker
    const view = await repo.taskView(db, first);
    expect(view.state).toBe("claimed");
    expect(["runner:w1", "runner:w2"]).toContain(view.runner);
  });

  it("re-queues a task whose lease expired, marks the old claim expired, and heartbeats renew leases", async () => {
    const { worker: w } = await repo.registerWorker(db, { name: "w3", lanes: ["grok"] });
    const task = await newTask("grok");
    const got = await repo.claimNext(db, { workerId: w.id, lanes: ["grok"], leaseMs: 1000 });
    expect(got?.task.id).toBe(task.id);
    const later = Date.now() + 5000;
    // still leased from the worker's point of view at `now`, nothing to claim
    expect(await repo.claimNext(db, { workerId: w.id, lanes: ["grok"] })).toBeUndefined();
    // the lease ran out: the next claim expires it and takes the task again
    const again = await repo.claimNext(db, { workerId: w.id, lanes: ["grok"], now: later });
    expect(again?.task.id).toBe(task.id);
    const history = await repo.listClaims(db, { taskId: task.id });
    expect(history.map((c) => c.outcome)).toEqual([null, "expired"]);
    // a heartbeat pushes the live lease forward
    const hb = await repo.heartbeatWorker(db, w.id, { now: later + 60_000 });
    expect(hb?.leases).toHaveLength(1);
    expect(new Date(hb!.leases[0]!.lease_until).getTime()).toBe(later + 60_000 + repo.LEASE_MS);
    expect(await repo.releaseClaim(db, task.id, w.id, "finished")).toBeDefined();
    expect(await repo.releaseClaim(db, task.id, w.id, "finished")).toBeUndefined();
    // a release alone does not finish a task (the run event does); without one it is queued again
    expect((await repo.taskView(db, task)).state).toBe("queued");
    await repo.writeEvent(db, { kind: "run.finished", actor: "runner:w3", repo: task.repo, issue: task.issue, lane: "grok", summary: "x", payload: { conclusion: "success" } });
    expect((await repo.taskView(db, task)).state).toBe("review");
  });

  it("honours lane.labels: a task whose project needs gpu waits for a worker that has it", async () => {
    await repo.upsertPreference(db, { key: "lane.labels", value: "gpu", scope: "project", scope_id: "gpu", reason: null });
    const { worker: plain } = await repo.registerWorker(db, { name: "plain", lanes: ["claude"] });
    const { worker: big } = await repo.registerWorker(db, { name: "big", lanes: ["claude"], labels: ["gpu", "xcode"] });
    const task = await newTask("claude", "gpu", "acme/gpu");
    expect(await repo.claimNext(db, { workerId: plain.id, lanes: ["claude"], labels: [] })).toBeUndefined();
    expect((await repo.claimNext(db, { workerId: big.id, lanes: ["claude"], labels: big.labels }))?.task.id).toBe(task.id);
    expect(repo.requiredLabels([{ key: "lane.labels", value: "a, b", scope: "lane", scope_id: "claude", reason: null }, { key: "lane.labels", value: "c", scope: "global", scope_id: null, reason: null }], "x", "claude")).toEqual(["a", "b"]);
    expect(repo.requiredLabels([{ key: "lane.labels", value: "c", scope: "global", scope_id: null, reason: null }], "x", "codex")).toEqual(["c"]);
  });

  it("does not hand out tasks that are running, in review or done", async () => {
    const { worker: w } = await repo.registerWorker(db, { name: "w4", lanes: ["codex"] });
    const running = await newTask("codex");
    const done = await newTask("codex");
    const open = await newTask("codex");
    await repo.writeEvent(db, { kind: "run.started", actor: "runner:elsewhere", repo: running.repo, issue: running.issue, lane: "codex", summary: "x" });
    await repo.writeEvent(db, { kind: "pr.merged", actor: "human:kyle", repo: done.repo, issue: done.issue, pr: 9, summary: "x" });
    expect((await repo.claimNext(db, { workerId: w.id, lanes: ["codex"] }))?.task.id).toBe(open.id);
    expect(await repo.claimNext(db, { workerId: w.id, lanes: ["codex"] })).toBeUndefined();
  });
});

describe("deriveTaskStatus with claims", () => {
  const task = { repo: "acme/demo", issue: 1 };
  const ev = (kind: string, ts: string, extra: Partial<repo.EventRow> = {}): repo.EventRow => ({ id: 0, ts, kind, actor: "runner:mini", project: "demo", repo: "acme/demo", issue: 1, pr: null, lane: "claude", model: null, subscription: null, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_equiv: 0, duration_ms: null, summary: kind, url: null, payload: {}, dedupe_key: null, ...extra });
  const now = Date.parse("2026-10-16T10:30:00Z");
  const claim = (over: Partial<ClaimLike> = {}): ClaimLike => ({ worker: "mini", claimed_at: "2026-10-16T10:00:00.000Z", lease_until: "2026-10-16T11:00:00.000Z", released_at: null, outcome: null, ...over });

  it("a live lease on a queued task is `claimed`", () => {
    const s = deriveTaskStatus(task, [], [claim()], now);
    expect(s.state).toBe("claimed");
    expect(s.runner).toBe("runner:mini");
  });
  it("run.started under a live lease is running; a finished run is review regardless of the lease", () => {
    expect(deriveTaskStatus(task, [ev("run.started", "2026-10-16T10:05:00.000Z")], [claim()], now).state).toBe("running");
    expect(deriveTaskStatus(task, [ev("run.started", "2026-10-16T10:05:00.000Z"), ev("run.finished", "2026-10-16T10:20:00.000Z", { payload: { conclusion: "success" } })], [claim({ released_at: "2026-10-16T10:20:00.000Z", outcome: "finished" })], now).state).toBe("review");
  });
  it("a lease that expired mid-run puts the task back to queued; an expired lease before any run is plain queued", () => {
    const expired = claim({ released_at: "2026-10-16T10:29:00.000Z", outcome: "expired" });
    expect(deriveTaskStatus(task, [ev("run.started", "2026-10-16T10:05:00.000Z")], [expired], now).state).toBe("queued");
    expect(deriveTaskStatus(task, [], [expired], now).state).toBe("queued");
    // a lease past its time that nobody marked yet is not live either
    expect(deriveTaskStatus(task, [], [claim({ lease_until: "2026-10-16T10:10:00.000Z" })], now).state).toBe("queued");
  });
});

describe("worker protocol (server side)", () => {
  it("register, heartbeat, claim, start, release write the documented events and enforce the lease", async () => {
    const reg = await registerWorkerServer(db, { name: "studio", host: "studio.local", lanes: ["claude"], labels: ["xcode"], version: "0.1.0" });
    expect(reg.created).toBe(true);
    expect(reg.events.map((e) => e.kind)).toEqual(["worker.registered", "worker.online"]);
    expect(reg.events[0]?.actor).toBe("runner:studio");
    const again = await registerWorkerServer(db, { name: "studio", host: "studio.local", lanes: ["claude"], version: "0.1.0" });
    expect(again.events).toEqual([]); // already online: nothing new to say

    const task = await newTask("claude");
    const claimed = await claimServer(db, { worker_id: reg.worker.id, lanes: ["claude", "codex"] }); // codex is not registered: filtered out
    expect(claimed?.task.id).toBe(task.id);
    expect(claimed?.issue).toBeNull();

    await expect(startServer(db, task.id, { worker_id: "nope" })).rejects.toBeInstanceOf(WorkError);
    const started = await startServer(db, task.id, { worker_id: reg.worker.id, branch: "relay/claude-" + task.issue });
    expect(started.events[0]?.kind).toBe("run.started");
    expect(started.events[0]?.actor).toBe("runner:studio");
    expect(started.events[0]?.lane).toBe("claude");
    expect((await repo.taskView(db, task)).state).toBe("running");

    const released = await releaseServer(db, task.id, {
      worker_id: reg.worker.id,
      outcome: "finished",
      pr: 12,
      pr_url: "https://github.com/acme/demo/pull/12",
      summary: "Added the thing",
      duration_ms: 1234,
      usage: { tool: "claude", model: "anthropic/claude-sonnet-5", subscription: "max", tokens_in: 100, tokens_out: 50, cache_read: 10, cache_write: 0, cost_equiv: 0.01, duration_ms: 1200 },
    });
    expect(released.claim.outcome).toBe("finished");
    expect(released.events.map((e) => e.kind)).toEqual(["run.finished", "step.usage"]);
    expect(released.events[1]?.actor).toBe("agent:claude");
    expect(released.events[1]?.tokens_in).toBe(100);
    const view = await repo.taskView(db, task);
    expect(view.state).toBe("review");
    expect(view.pr).toBe(12);
    expect(view.runner).toBe("runner:studio");
    // the lease is gone: a second release is a 409
    await expect(releaseServer(db, task.id, { worker_id: reg.worker.id, outcome: "failed" })).rejects.toMatchObject({ status: 409 });

    const off = await heartbeatServer(db, reg.worker.id, { status: "offline" });
    expect(off.events.map((e) => e.kind)).toEqual(["worker.offline"]);
    const back = await registerWorkerServer(db, { name: "studio", lanes: ["claude"] });
    expect(back.events.map((e) => e.kind)).toEqual(["worker.online"]);
    await expect(heartbeatServer(db, "ghost")).rejects.toMatchObject({ status: 404 });

    const views = await repo.workerViews(db);
    expect(views.find((w) => w.name === "studio")?.state).toBe("online");
  });

  it("a failed run writes run.failed and the task is failed", async () => {
    const reg = await registerWorkerServer(db, { name: "loft", lanes: ["grok"] });
    const task = await newTask("grok");
    const c = await claimServer(db, { worker_id: reg.worker.id });
    expect(c?.task.id).toBe(task.id);
    await startServer(db, task.id, { worker_id: reg.worker.id });
    const r = await releaseServer(db, task.id, { worker_id: reg.worker.id, outcome: "failed", error: "grok exited 1", usage: null });
    expect(r.events.map((e) => e.kind)).toEqual(["run.failed"]);
    expect((await repo.taskView(db, task)).state).toBe("failed");
  });
});

describe("service files", () => {
  const base = { node: "/opt/node/bin/node", cliArgv: ["/usr/lib/relay/dist/relay.js"], home: "/Users/relay/.harness", userHome: "/Users/relay", path: "/opt/node/bin:/usr/bin:/bin", uid: 502 } as const;
  it("macOS: a LaunchAgent in the user's context with the log under RELAY_HOME", () => {
    const p = servicePlan({ ...base, platform: "darwin", args: ["--lanes", "claude,codex"] });
    expect(p.path).toBe("/Users/relay/Library/LaunchAgents/house.kyro.relay.work.plist");
    expect(p.content).toContain("<string>/opt/node/bin/node</string>");
    expect(p.content).toContain("<string>/usr/lib/relay/dist/relay.js</string>");
    expect(p.content).toContain("<string>work</string>");
    expect(p.content).toContain("<string>claude,codex</string>");
    expect(p.content).toContain("<key>KeepAlive</key><true/>");
    expect(p.content).toContain("<key>StandardOutPath</key><string>/Users/relay/.harness/work.log</string>");
    expect(p.content).toContain("<key>RELAY_HOME</key><string>/Users/relay/.harness</string>");
    expect(p.load).toEqual([["launchctl", "bootstrap", "gui/502", p.path]]);
    expect(p.unload[0]).toEqual(["launchctl", "bootout", "gui/502/house.kyro.relay.work"]);
  });
  it("Linux: a systemd user unit that restarts and appends to the log", () => {
    const p = servicePlan({ ...base, platform: "linux", userHome: "/home/relay", home: "/home/relay/.harness" });
    expect(p.path).toBe("/home/relay/.config/systemd/user/relay-work.service");
    expect(p.content).toContain("ExecStart=/opt/node/bin/node /usr/lib/relay/dist/relay.js work");
    expect(p.content).toContain("Restart=always");
    expect(p.content).toContain("StandardOutput=append:/home/relay/.harness/work.log");
    expect(p.content).toContain("Environment=PATH=/opt/node/bin:/usr/bin:/bin");
    expect(p.content).toContain("Environment=RELAY_HOME=/home/relay/.harness");
    expect(p.load.at(-1)).toEqual(["systemctl", "--user", "enable", "--now", "relay-work.service"]);
  });
});
