/**
 * The scheduler (docs/WORKERS.md): claims are atomic and leased, expired leases re-queue, lane.labels gate claims,
 * task state learns `claimed`, the server protocol writes the documented events, the queue version moves on every
 * write that changes the queue, the doorbell counts what looks queued, and the worker loop backs off while idle.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { openDb, type Db } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import * as repo from "../src/db/repo.ts";
import { deriveTaskStatus, type ClaimLike } from "../src/db/tasks.ts";
import type { MeterReading } from "../src/meters.ts";
import { localWorkApi, type WorkApi } from "../src/work/api.ts";
import type { JobResult } from "../src/work/job.ts";
import { claimServer, doorbellServer, forgetWorkerServer, heartbeatServer, registerWorkerServer, releaseServer, startServer, WorkError, type ClaimResult } from "../src/work/server.ts";
import { servicePlan } from "../src/work/service.ts";
import { fxLoginWords, isLoginProvider, LOGIN_PROVIDERS, loginDonePage, manualLoginSteps, OAUTH_PROVIDERS, parseLoginCallback, parseLoginUrl, replayUrl } from "../src/work/login.ts";
import {
  CONTAINER_LOGIN_COMMAND,
  CONTAINER_LOGIN_STEPS,
  CONTAINER_NAME,
  CONTAINER_VOLUME,
  containerLoginSteps,
  containerPlan,
  containerSettingsFrom,
  containerStateFrom,
  containerWorkerName,
  fmtMemory,
  imageStatus,
  lanesFromDoctorOutput,
  loginStatesFromDoctorOutput,
  tokenNameFromDoctorOutput,
} from "../src/work/container.ts";
import { runWorker } from "../src/work/worker.ts";

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

describe("forgetWorker (relay work forget, DELETE /api/v1/workers/{id})", () => {
  it("deletes the row by name or id, keeps the claims attributed, writes worker.forgotten as the caller", async () => {
    const reg = await registerWorkerServer(db, { name: "old-mac", host: "old-mac.local", lanes: ["claude"], version: "0.2.0" });
    const task = await newTask("claude");
    await claimServer(db, { worker_id: reg.worker.id });
    await startServer(db, task.id, { worker_id: reg.worker.id });
    await releaseServer(db, task.id, { worker_id: reg.worker.id, outcome: "finished", pr: 7, pr_url: "https://github.com/acme/demo/pull/7" });

    const r = await forgetWorkerServer(db, "old-mac", "human:kyle");
    expect(r.worker.id).toBe(reg.worker.id);
    expect(r.events.map((e) => e.kind)).toEqual(["worker.forgotten"]);
    expect(r.events[0]?.actor).toBe("human:kyle");
    expect(r.events[0]?.summary).toContain("old-mac forgotten");
    expect(r.events[0]?.payload).toMatchObject({ worker: reg.worker.id, name: "old-mac", host: "old-mac.local", lanes: ["claude"] });
    expect(await repo.getWorker(db, reg.worker.id)).toBeUndefined();
    expect((await repo.workerViews(db)).some((w) => w.name === "old-mac")).toBe(false);
    // the claim history stays (no cascade), and the task's run is still attributed to the worker that ran it
    const claims = await repo.listClaims(db, { workerId: reg.worker.id });
    expect(claims.map((c) => c.outcome)).toEqual(["finished"]);
    const view = await repo.taskView(db, task);
    expect(view.state).toBe("review");
    expect(view.runner).toBe("runner:old-mac");
    // unknown afterwards, by name and by id
    await expect(forgetWorkerServer(db, "old-mac", "human:kyle")).rejects.toMatchObject({ status: 404 });
    await expect(forgetWorkerServer(db, reg.worker.id, "human:kyle")).rejects.toMatchObject({ status: 404 });
  });

  it("refuses with 409 while the worker holds a live claim, and forgets once it is released", async () => {
    const reg = await registerWorkerServer(db, { name: "busy", lanes: ["codex"] });
    const task = await newTask("codex");
    const c = await claimServer(db, { worker_id: reg.worker.id });
    expect(c?.task.id).toBe(task.id);
    await expect(forgetWorkerServer(db, "busy", "human:kyle")).rejects.toMatchObject({ status: 409 });
    expect(await repo.getWorker(db, reg.worker.id)).toBeDefined();
    await releaseServer(db, task.id, { worker_id: reg.worker.id, outcome: "released" });
    const r = await forgetWorkerServer(db, reg.worker.id, "token:ops");
    expect(r.worker.name).toBe("busy");
    expect(r.events[0]?.actor).toBe("token:ops");
  });

  it("a worker that registers again after being forgotten gets a fresh row, and a heartbeat on the old id is a 404", async () => {
    const first = await registerWorkerServer(db, { name: "mini-container", lanes: ["claude"] });
    await forgetWorkerServer(db, "mini-container", "human:kyle");
    await expect(heartbeatServer(db, first.worker.id)).rejects.toMatchObject({ status: 404 });
    const again = await registerWorkerServer(db, { name: "mini-container", lanes: ["claude", "codex"] });
    expect(again.created).toBe(true);
    expect(again.worker.id).not.toBe(first.worker.id);
    expect(again.events.map((e) => e.kind)).toEqual(["worker.registered", "worker.online"]);
    await forgetWorkerServer(db, "mini-container", "human:kyle");
  });

  it("marks a worker offline for more than 7 days as retired; a fresh offline report is not retired", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    const day = 24 * 60 * 60_000;
    expect(repo.workerRetired({ last_seen: new Date(now - 8 * day).toISOString(), status: "online" }, now)).toBe(true);
    expect(repo.workerRetired({ last_seen: new Date(now - 8 * day).toISOString(), status: "offline" }, now)).toBe(true);
    expect(repo.workerRetired({ last_seen: new Date(now - 3 * day).toISOString(), status: "offline" }, now)).toBe(false);
    expect(repo.workerRetired({ last_seen: new Date(now - 60_000).toISOString(), status: "offline" }, now)).toBe(false);
    expect(repo.workerRetired({ last_seen: new Date(now - 8 * day).toISOString(), status: "online" }, now - 8 * day + 1000)).toBe(false);
  });

  it("the loop registers again when the site has forgotten it", async () => {
    const reg = await registerWorkerServer(db, { name: "loop-fresh", lanes: ["grok"] });
    const api = localWorkApi(db, { dispatch: false });
    let claims = 0;
    const spy: WorkApi = {
      ...api,
      async claim(input) {
        claims++;
        if (claims === 1) {
          await forgetWorkerServer(db, "loop-fresh", "human:kyle"); // forgotten between the registration and the first claim
          return api.claim(input); // the old id: a 404
        }
        expect(input.worker_id).not.toBe(reg.worker.id); // the retry carries the new id
        return null;
      },
    };
    const logs: string[] = [];
    const r = await runWorker({ api: spy, name: "loop-fresh", host: "h", lanes: ["grok"], version: "t", once: true, log: (m) => logs.push(m) });
    expect(claims).toBe(2);
    expect(r.worker.id).not.toBe(reg.worker.id);
    expect(logs.some((l) => l.includes("forgotten on the site; registered again"))).toBe(true);
    await forgetWorkerServer(db, "loop-fresh", "human:kyle");
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
  it("container mode, macOS: the LaunchAgent keeps `container start --attach relay-work` alive and runs no relay itself", () => {
    const p = servicePlan({ ...base, platform: "darwin", args: ["--lanes", "claude"], isolation: { kind: "container", bin: "/usr/local/bin/container" } });
    expect(p.path).toBe("/Users/relay/Library/LaunchAgents/house.kyro.relay.work.plist");
    const argv = [...p.content.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    expect(argv.slice(1, 5)).toEqual(["/usr/local/bin/container", "start", "--attach", "relay-work"]);
    expect(p.content).not.toContain("/opt/node/bin/node");
    expect(p.content).not.toContain("<string>work</string>");
    expect(p.content).not.toContain("claude"); // the worker's arguments live in the container, not the service
    expect(p.content).toContain("<key>KeepAlive</key><true/>");
    expect(p.content).toContain("<key>HOME</key><string>/Users/relay</string>");
    expect(p.content).not.toContain("RELAY_HOME"); // the container has its own
    expect(p.content).toContain("<key>StandardOutPath</key><string>/Users/relay/.harness/work.log</string>");
    expect(p.load).toEqual([["launchctl", "bootstrap", "gui/502", p.path]]);
  });
  it("container mode, Linux: the unit's ExecStart is the container command", () => {
    const p = servicePlan({ ...base, platform: "linux", userHome: "/home/relay", home: "/home/relay/.harness", isolation: { kind: "container", bin: "/usr/bin/container" } });
    expect(p.content).toContain("ExecStart=/usr/bin/container start --attach relay-work");
    expect(p.content).toContain("Description=relay worker: keeps the relay-work container running");
    expect(p.content).toContain("Restart=always");
    expect(p.content).not.toContain("RELAY_HOME");
  });
});

describe("container plan (relay work --isolation container)", () => {
  const spec = { bin: "/usr/local/bin/container", image: "relay-worker:0.1.0", context: "/Users/kyle/.harness/container", site: "https://relay.example.com", workerName: "mac-container", host: "mac.local" };
  it("names the worker after the host", () => {
    expect(containerWorkerName("Studio.local")).toBe("studio-container");
    expect(containerWorkerName("mac")).toBe("mac-container");
  });
  it("creates relay-work on the named volume with no host mounts, the runtime masks off, and the worker identity in the environment", () => {
    const p = containerPlan({ ...spec, args: ["--lanes", "claude,codex"], env: { RELAY_LANE_ALLOWED_DOMAINS: "pkg.example" } });
    expect(p.build).toEqual(["/usr/local/bin/container", "build", "--tag", "relay-worker:0.1.0", "/Users/kyle/.harness/container"]);
    expect(p.volumeCreate).toEqual(["/usr/local/bin/container", "volume", "create", CONTAINER_VOLUME]);
    expect(p.create.slice(0, 4)).toEqual(["/usr/local/bin/container", "create", "--name", CONTAINER_NAME]);
    expect(p.create).toContain(`${CONTAINER_VOLUME}:/home/relay`);
    expect(p.create.join(" ")).toContain("--publish 127.0.0.1:3000:3000 --publish 127.0.0.1:1455:1455 --masked-path NONE --read-only-path NONE --memory 4G --cpus 4");
    expect(containerPlan({ ...spec, memory: "8G", cpus: 6 }).create.join(" ")).toContain("--memory 8G --cpus 6");
    expect(p.create.join(" ")).toContain("--env RELAY_HOME=/home/relay/.harness");
    expect(p.create.join(" ")).toContain("--env RELAY_ISOLATION=container");
    expect(p.create.join(" ")).toContain("--env RELAY_WORKER_NAME=mac-container");
    expect(p.create.join(" ")).toContain("--env RELAY_WORKER_HOST=mac.local");
    expect(p.create.join(" ")).toContain("--env RELAY_LANE_ALLOWED_DOMAINS=pkg.example");
    expect(p.create.slice(-4)).toEqual(["relay-worker:0.1.0", "relay", "work", "--lanes", "claude,codex"].slice(1));
    expect(p.create.filter((w) => w === "--mount" || w.startsWith("type=bind"))).toEqual([]);
    expect(p.create.join(" ")).not.toContain("/Users/");
  });
  it("installs relay from npm when the context has no tarball", () => {
    const p = containerPlan({ ...spec, relaySpec: "@kyleroche/relay@0.1.0" });
    expect(p.build).toContain("--build-arg");
    expect(p.build).toContain("RELAY_SPEC=@kyleroche/relay@0.1.0");
  });
  it("runs setup, the shell and doctor inside as the relay user; the service attaches", () => {
    const p = containerPlan({ ...spec, invite: "abc" });
    expect(p.setup).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "-it", "relay-work", "relay", "setup", "--site", "https://relay.example.com", "--name", "relay-cli@mac-container", "--invite", "abc"]);
    expect(p.shell).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "-it", "relay-work", "bash"]);
    expect(p.doctor).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "relay-work", "relay", "doctor"]);
    expect(p.attach).toEqual(["/usr/local/bin/container", "start", "--attach", "relay-work"]);
    expect(p.logs(true, 20)).toEqual(["/usr/local/bin/container", "logs", "--follow", "-n", "20", "relay-work"]);
    expect(p.remove).toEqual(["/usr/local/bin/container", "delete", "relay-work"]);
  });
  it("reads the container's state from `container list --all --format json`", () => {
    const json = JSON.stringify([
      { configuration: { id: "buildkit", image: { reference: "ghcr.io/apple/container-builder-shim/builder:0.13.1" } }, status: { state: "running" } },
      { configuration: { id: "relay-work", image: { reference: "relay-worker:0.1.0" } }, status: { state: "stopped" } },
    ]);
    expect(containerStateFrom(json)).toEqual({ exists: true, running: false, state: "stopped", image: "relay-worker:0.1.0" });
    expect(containerStateFrom(JSON.stringify([{ configuration: { id: "relay-work" }, status: { state: "running" } }]))).toEqual({ exists: true, running: true, state: "running" });
    expect(containerStateFrom("[]")).toEqual({ exists: false, running: false });
    expect(containerStateFrom("not json")).toEqual({ exists: false, running: false });
  });
  it("reads the lanes line of `relay doctor` output", () => {
    expect(lanesFromDoctorOutput("ok    node          v24.1.0\nok    lanes         claude, codex (relay work would serve these); not: grok: no grok CLI or fx login\nok    sandbox       x")).toEqual(["claude", "codex"]);
    expect(lanesFromDoctorOutput("warn  lanes         none: gh is not logged in (run: gh auth login); no lane can push without it")).toEqual([]);
    expect(lanesFromDoctorOutput("ok    node          v24.1.0")).toBeUndefined();
  });
  it("probes the site token in the volume and tells relay-entry which login ports to forward", () => {
    const p = containerPlan(spec);
    expect(p.credentials).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "relay-work", "test", "-f", "/home/relay/.harness/credentials.json"]);
    expect(p.create.join(" ")).toContain("--env RELAY_LOGIN_PORTS=3000 1455");
  });
  it("spells the login commands: fx with its browser off and stdin open, claude and gh on a TTY, the redirect replay with curl inside", () => {
    const p = containerPlan(spec);
    expect(p.login.fx("grok")).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "-i", "relay-work", "env", "FX_NO_OPEN_BROWSER=1", "fx", "login", "grok"]);
    expect(p.login.fx("codex").slice(-2)).toEqual(["login", "codex"]);
    expect(p.login.claude).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "-it", "relay-work", "claude"]);
    expect(p.login.gh).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "-it", "relay-work", "gh", "auth", "login", "--git-protocol", "https", "--web"]);
    expect(p.login.ghSetupGit).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "relay-work", "gh", "auth", "setup-git"]);
    expect(p.login.replay("http://localhost:1455/auth/callback?code=c&state=s")).toEqual(["/usr/local/bin/container", "exec", "--user", "relay", "relay-work", "curl", "-fsS", "-o", "/dev/null", "http://localhost:1455/auth/callback?code=c&state=s"]);
  });

  const DOCTOR_INSIDE = [
    "ok    node          v24.11.0",
    "ok    cli:claude    /usr/local/bin/claude",
    "ok    login:claude  logged in (max)",
    "warn  cli:codex     not on PATH",
    "ok    cli:fx        /usr/local/bin/fx",
    "ok    login:fx      connected: codex",
    "warn  cli:grok      not on PATH",
    "ok    cli:gh        /usr/bin/gh",
    "fail  login:gh      not logged in; run: gh auth login",
    "warn  lanes         none: gh is not logged in (run: gh auth login); no lane can push without it",
    "ok    mode          site: https://relay.example.com (memory, feed, token, invite, task and webhook commands and the hooks use it)",
    "ok    auth          approved on /activate (device flow) as oauth:relay-cli@mac-container, expires 2026-11-16T22:10:02.000Z; renews itself with a refresh token",
  ].join("\n");

  it("reads the logins from `relay doctor` output inside: fx covers codex and grok, an expired fx counts as missing", () => {
    expect(loginStatesFromDoctorOutput(DOCTOR_INSIDE)).toEqual({ claude: true, gh: false, codex: true, grok: false });
    expect(loginStatesFromDoctorOutput(DOCTOR_INSIDE.replace("ok    login:fx      connected: codex", "ok    login:fx      connected: codex, grok").replace("fail  login:gh      not logged in; run: gh auth login", "ok    login:gh      logged in"))).toEqual({ claude: true, gh: true, codex: true, grok: true });
    expect(loginStatesFromDoctorOutput(DOCTOR_INSIDE.replace("ok    login:fx      connected: codex", "warn  login:fx      connected: codex; token expired and not refreshable, run: fx login"))).toEqual({ claude: true, gh: false, codex: false, grok: false });
    expect(loginStatesFromDoctorOutput(DOCTOR_INSIDE.replace("warn  cli:grok      not on PATH", "ok    cli:grok      /usr/local/bin/grok")).grok).toBe(true);
    expect(loginStatesFromDoctorOutput("")).toEqual({ claude: false, gh: false, codex: false, grok: false });
  });
  it("reads the token's name from doctor's auth line", () => {
    expect(tokenNameFromDoctorOutput(DOCTOR_INSIDE)).toBe("oauth:relay-cli@mac-container");
    expect(tokenNameFromDoctorOutput("ok    auth          pasted with --token as ci, no expiry")).toBe("ci");
    expect(tokenNameFromDoctorOutput("ok    auth          pasted with --token, no expiry")).toBeUndefined();
    expect(tokenNameFromDoctorOutput("")).toBeUndefined();
  });
  it("marks the login steps the volume already holds as kept; without doctor output every step is an instruction", () => {
    const unknown = containerLoginSteps();
    expect(unknown.allKept).toBe(false);
    expect(unknown.steps.map((s) => s.cmd)).toEqual(CONTAINER_LOGIN_STEPS.map((s) => s.cmd));
    expect(unknown.steps.every((s) => s.kept === undefined)).toBe(true);
    const some = containerLoginSteps(DOCTOR_INSIDE);
    expect(some.allKept).toBe(false);
    expect(some.steps.map((s) => [s.cmd, s.kept])).toEqual([
      ["relay work container shell", undefined],
      ["claude", true],
      ["gh auth login && gh auth setup-git", false],
      ["fx login codex", true],
      ["FX_NO_OPEN_BROWSER=1 fx login grok", false],
      ["exit", undefined],
    ]);
    const all = containerLoginSteps(DOCTOR_INSIDE.replace("ok    login:fx      connected: codex", "ok    login:fx      connected: codex, grok").replace("fail  login:gh      not logged in; run: gh auth login", "ok    login:gh      logged in"));
    expect(all.allKept).toBe(true);
    expect(all.steps.filter((s) => s.kept).map((s) => s.login)).toEqual(["claude", "gh", "codex", "grok"]);
  });
  it("reads the settings an update carries over from the container's row: the baked arguments, the passthrough env, the name, the size", () => {
    const row = {
      configuration: {
        id: "relay-work",
        image: { reference: "relay-worker:0.1.0" },
        initProcess: {
          arguments: ["relay", "work", "--lanes", "claude", "--jobs", "2"],
          environment: ["PATH=/usr/local/bin:/usr/bin", "RELAY_HOME=/home/relay/.harness", "RELAY_ISOLATION=container", "RELAY_WORKER_NAME=mac-container", "RELAY_WORKER_HOST=mac.local", "RELAY_LANE_ALLOWED_DOMAINS=pkg.example", "RELAY_LOGIN_PORTS=3000 1455", "NODE_VERSION=24.11.0"],
        },
        resources: { cpuOverhead: 1, cpus: 6, memoryInBytes: 8 * 2 ** 30 },
      },
      status: { state: "running" },
    };
    expect(containerSettingsFrom(JSON.stringify([row]))).toEqual({ args: ["--lanes", "claude", "--jobs", "2"], env: { RELAY_LANE_ALLOWED_DOMAINS: "pkg.example" }, workerName: "mac-container", host: "mac.local", memory: "8G", cpus: 6 });
    expect(containerSettingsFrom(JSON.stringify([{ configuration: { id: "relay-work", initProcess: { arguments: ["sleep", "infinity"] } } }]))).toEqual({ args: [], env: {} });
    expect(containerSettingsFrom("[]")).toBeUndefined();
    expect(containerSettingsFrom("nope")).toBeUndefined();
    expect(fmtMemory(4 * 2 ** 30)).toBe("4G");
    expect(fmtMemory(1536 * 2 ** 20)).toBe("1536M");
    expect(fmtMemory(2 ** 10)).toBe("1K");
    expect(fmtMemory(1000)).toBe("1000");
  });
  it("says whether the container runs this relay's image", () => {
    expect(imageStatus("relay-worker:0.2.0", "relay-worker:0.2.0")).toEqual({ current: true, line: "relay-worker:0.2.0 (this relay's build)" });
    const stale = imageStatus("relay-worker:0.1.0", "relay-worker:0.2.0");
    expect(stale.current).toBe(false);
    expect(stale.line).toContain("rebuild with relay work container update");
    expect(imageStatus(undefined, "relay-worker:0.2.0").current).toBe(false);
  });
});

describe("queue version", () => {
  it("moves when a task is opened, a claim is released or a lease expires, and not on a claim", async () => {
    const v0 = await repo.getQueueVersion(db);
    const task = await newTask("claude");
    expect(await repo.getQueueVersion(db)).toBe(v0 + 1);
    // the same task again: nothing new, no bump
    await repo.createTask(db, { project: "demo", repo: "acme/demo", issue: task.issue, createdBy: "human:kyle", lane: "claude" });
    expect(await repo.getQueueVersion(db)).toBe(v0 + 1);
    const { worker } = await repo.registerWorker(db, { name: "bell", lanes: ["claude"] });
    const got = await repo.claimNext(db, { workerId: worker.id, lanes: ["claude"], leaseMs: 1000 });
    expect(got?.task.id).toBe(task.id);
    expect(await repo.getQueueVersion(db)).toBe(v0 + 1); // a claim takes work; it does not ring anyone's bell
    // the lease runs out: the expiry re-queues the task and moves the version once, and a second sweep finds nothing
    expect(await repo.expireLeases(db, Date.now() + 5000)).toHaveLength(1);
    expect(await repo.getQueueVersion(db)).toBe(v0 + 2);
    expect(await repo.expireLeases(db, Date.now() + 5000)).toHaveLength(0);
    expect(await repo.getQueueVersion(db)).toBe(v0 + 2);
    // claim again and release: one more move
    expect((await repo.claimNext(db, { workerId: worker.id, lanes: ["claude"] }))?.task.id).toBe(task.id);
    expect(await repo.releaseClaim(db, task.id, worker.id, "finished")).toBeDefined();
    expect(await repo.getQueueVersion(db)).toBe(v0 + 3);
    expect(await repo.releaseClaim(db, task.id, worker.id, "finished")).toBeUndefined();
    expect(await repo.getQueueVersion(db)).toBe(v0 + 3);
    // a worker lane learned late (relabelled on GitHub) is a queue change too
    await repo.createTask(db, { project: "demo", repo: "acme/demo", issue: task.issue, createdBy: "human:kyle", lane: "codex" });
    expect(await repo.getQueueVersion(db)).toBe(v0 + 4);
  });
});

describe("doorbell", () => {
  let fresh: Db;
  let issue = 0;
  const open = async (lane: string) => (await repo.createTask(fresh, { project: "demo", repo: "acme/demo", issue: ++issue, createdBy: "human:kyle", lane })).task;
  beforeAll(async () => {
    fresh = await openDb({ file: ":memory:" });
    await migrate(fresh);
    await repo.upsertProject(fresh, { slug: "demo", repo: "acme/demo", path: "/tmp/demo" });
  });
  afterAll(async () => {
    await fresh.close();
  });

  it("counts the tasks that look queued, per lane, leaving out cloud lanes, live leases and finished runs", async () => {
    expect(await doorbellServer(fresh)).toMatchObject({ version: 0, queued: 0 });
    const a = await open("claude");
    await open("codex-cloud"); // dispatched by the site, never claimed by a worker
    const bell = await doorbellServer(fresh);
    expect(bell.queued).toBe(1);
    expect(bell.version).toBe(2);
    expect(Date.parse(bell.ts)).toBeGreaterThan(0);
    expect((await doorbellServer(fresh, { lanes: ["codex"] })).queued).toBe(0);
    expect((await doorbellServer(fresh, { lanes: ["claude", "codex"] })).queued).toBe(1);
    // a live lease takes it off the count; a release puts it back
    const { worker } = await repo.registerWorker(fresh, { name: "w", lanes: ["claude"] });
    const got = await repo.claimNext(fresh, { workerId: worker.id, lanes: ["claude"] });
    expect(got?.task.id).toBe(a.id);
    expect((await doorbellServer(fresh)).queued).toBe(0);
    await repo.releaseClaim(fresh, a.id, worker.id, "released");
    expect((await doorbellServer(fresh)).queued).toBe(1);
    // started under a lease that then ran out: the worker vanished, so it looks queued again
    await repo.claimNext(fresh, { workerId: worker.id, lanes: ["claude"], leaseMs: 1000 });
    await repo.writeEvent(fresh, { kind: "run.started", actor: "runner:w", repo: a.repo, issue: a.issue, lane: "claude", summary: "x" });
    expect((await doorbellServer(fresh)).queued).toBe(0);
    await repo.expireLeases(fresh, Date.now() + 5000);
    expect((await doorbellServer(fresh)).queued).toBe(1);
    // a finished run ends it; a closed PR without a merge re-queues it; a merge is final
    await repo.writeEvent(fresh, { kind: "run.finished", actor: "runner:w", repo: a.repo, issue: a.issue, lane: "claude", summary: "x", payload: { conclusion: "success" } });
    expect((await doorbellServer(fresh)).queued).toBe(0);
    await repo.writeEvent(fresh, { kind: "pr.closed", actor: "human:kyle", repo: a.repo, issue: a.issue, pr: 1, summary: "x" });
    expect((await doorbellServer(fresh)).queued).toBe(1);
    await repo.writeEvent(fresh, { kind: "pr.merged", actor: "human:kyle", repo: a.repo, issue: a.issue, pr: 1, summary: "x" });
    expect((await doorbellServer(fresh)).queued).toBe(0);
    // a run started by an Actions runner (no claim ever) is running, not queued
    const b = await open("grok");
    await repo.writeEvent(fresh, { kind: "run.started", actor: "runner:actions", repo: b.repo, issue: b.issue, lane: "grok", summary: "x" });
    expect((await doorbellServer(fresh, { lanes: ["grok"] })).queued).toBe(0);
    // the local WorkApi serves the same thing
    const api = localWorkApi(fresh, { dispatch: false });
    expect(await api.doorbell({ lanes: ["claude"] })).toMatchObject({ queued: 0, version: await repo.getQueueVersion(fresh) });
  });

  it("the heartbeat records the interval the worker is on", async () => {
    const { worker } = await repo.registerWorker(fresh, { name: "slow", lanes: ["claude"] });
    expect(worker.poll_ms).toBeNull();
    const hb = await heartbeatServer(fresh, worker.id, { interval_ms: 300_000 });
    expect(hb.worker.poll_ms).toBe(300_000);
    // a heartbeat without one keeps the last
    expect((await heartbeatServer(fresh, worker.id)).worker.poll_ms).toBe(300_000);
    expect((await repo.workerViews(fresh)).find((w) => w.name === "slow")?.poll_ms).toBe(300_000);
  });

  it("the heartbeat stores the plan meters the worker read, replaces them when sent, keeps them when not, drops junk", async () => {
    const { worker } = await repo.registerWorker(fresh, { name: "metered", lanes: ["claude"] });
    expect(worker.meters).toEqual([]);
    const captured = new Date().toISOString();
    const five: MeterReading = { subscription: "max", window: "5h", used_percentage: 42, resets_at: "2026-10-17T15:00:00.000Z", captured_at: captured, source: "claude-statusline" };
    const week: MeterReading = { subscription: "max", window: "7d", used_percentage: 44, resets_at: null, captured_at: captured, source: "claude-statusline" };
    const hb = await heartbeatServer(fresh, worker.id, { interval_ms: 15_000, meters: [five, week] });
    expect(hb.worker.meters).toEqual([five, week]);
    // no meters in the body: the stored list stays; the view and the local WorkApi expose it
    expect((await heartbeatServer(fresh, worker.id)).worker.meters).toEqual([five, week]);
    expect((await repo.workerViews(fresh)).find((w) => w.name === "metered")?.meters).toEqual([five, week]);
    expect((await localWorkApi(fresh, { dispatch: false }).workers()).find((w) => w.name === "metered")?.meters).toHaveLength(2);
    // a later heartbeat replaces the list (the 7d window vanished); junk entries never reach the row
    const hb2 = await heartbeatServer(fresh, worker.id, { meters: [{ ...five, used_percentage: 43 }, { window: "1y", used_percentage: 1, captured_at: captured } as unknown as MeterReading] });
    expect(hb2.worker.meters).toEqual([{ ...five, used_percentage: 43 }]);
    expect((await heartbeatServer(fresh, worker.id, { meters: [] })).worker.meters).toEqual([]);
  });

  it("the worker loop sends the meter files it reads with every heartbeat, including the offline one", async () => {
    const { worker } = await repo.registerWorker(fresh, { name: "loop-meters", lanes: ["claude"] });
    const sent: Array<MeterReading[] | undefined> = [];
    const base = localWorkApi(fresh, { dispatch: false });
    const api: WorkApi = { ...base, heartbeat: (id, input = {}) => (sent.push(input.meters), base.heartbeat(id, input)) };
    const reading: MeterReading = { subscription: "max", window: "5h", used_percentage: 9, resets_at: null, captured_at: new Date().toISOString(), source: "claude-statusline" };
    await runWorker({ api, name: "loop-meters", host: "h", lanes: ["claude"], version: "t", once: true, meters: () => [reading] });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((m) => m?.length === 1 && m[0]!.used_percentage === 9)).toBe(true);
    expect((await repo.getWorker(fresh, worker.id))?.meters).toEqual([reading]);
    // a reader that throws costs nothing: the heartbeat goes out with no meters
    const sent2: Array<MeterReading[] | undefined> = [];
    const api2: WorkApi = { ...base, heartbeat: (id, input = {}) => (sent2.push(input.meters), base.heartbeat(id, input)) };
    await runWorker({
      api: api2,
      name: "loop-meters",
      host: "h",
      lanes: ["claude"],
      version: "t",
      once: true,
      meters: () => {
        throw new Error("disk");
      },
    });
    expect(sent2.every((m) => Array.isArray(m) && m.length === 0)).toBe(true);
  });
});

/**
 * The loop against a fake WorkApi under fake timers: `calls` is every request in order with its fake-clock time, so
 * the request budget, the backoff and the heartbeat cadence are all visible. `set` changes what the doorbell says and
 * what the next claim returns.
 */
function fakeWorkApi() {
  const calls: Array<{ t: number; what: string; interval?: number }> = [];
  const state = { version: 1, queued: 0, claims: [] as ClaimResult[] };
  const worker = { id: "w1", name: "fake", host: "fake.local", lanes: ["claude"], labels: [], version: "0.1.0", last_seen: "", status: "online" as const, poll_ms: null, created_at: "" };
  const api: WorkApi = {
    mode: "local",
    async register() {
      calls.push({ t: Date.now(), what: "register" });
      return { worker, created: true, events: [] };
    },
    async heartbeat(_id, input = {}) {
      calls.push({ t: Date.now(), what: input.status === "offline" ? "heartbeat:offline" : "heartbeat", ...(input.interval_ms ? { interval: input.interval_ms } : {}) });
      return { worker, leases: [], events: [] };
    },
    async doorbell() {
      calls.push({ t: Date.now(), what: "doorbell" });
      return { version: state.version, queued: state.queued, ts: new Date().toISOString() };
    },
    async claim() {
      calls.push({ t: Date.now(), what: "claim" });
      return state.claims.shift() ?? null;
    },
    async start() {},
    async release() {},
    async brief() {
      return { text: "", tokens: 0 };
    },
    async workers() {
      return [];
    },
  };
  const claimFor = (id: string): ClaimResult => ({
    claim: { id: `c-${id}`, task_id: id, worker_id: worker.id, lease_until: new Date(Date.now() + 1_800_000).toISOString(), claimed_at: new Date().toISOString(), released_at: null, outcome: null },
    task: { id, project: "demo", repo: "acme/demo", issue: 1, idempotency_key: null, created_by: "human:kyle", created_at: "", lane: "claude" },
    issue: null,
    base: null,
  });
  const only = (what: string) => calls.filter((c) => c.what === what);
  const since = (what: string, t: number) => only(what).filter((c) => c.t >= t);
  /** Gaps between consecutive doorbell reads from `t` on, in seconds. */
  const gaps = (t = 0) => since("doorbell", t).map((c) => c.t).map((x, i, a) => (i ? (x - a[i - 1]!) / 1000 : null)).filter((x): x is number => x !== null);
  return { api, calls, state, claimFor, only, since, gaps };
}

describe("runWorker loop: doorbell and backoff", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("claims once at start, then only when the version moves; backs off 15 -> 30 -> ... -> 300 s; resets on work; heartbeats on cadence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = fakeWorkApi();
    const ac = new AbortController();
    const intervals: number[] = [];
    let jobStarted = -1;
    const loop = runWorker({
      api: f.api,
      name: "fake",
      host: "fake.local",
      lanes: ["claude"],
      version: "0.1.0",
      signal: ac.signal,
      onInterval: (ms) => intervals.push(ms / 1000),
      runJob: async (claim): Promise<JobResult> => {
        jobStarted = Date.now();
        await new Promise((r) => setTimeout(r, 130_000)); // two heartbeats' worth of lane time
        return { task: claim.task.id, lane: "claude", branch: "relay/claude-1", outcome: "finished", usage: { tool: "claude", model: null, subscription: null, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_equiv: 0, duration_ms: 0 }, summary: "ok", durationMs: 130_000 };
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    // startup: register, one doorbell, one claim (the queue is drained at start whatever the bell says)
    expect(f.calls.map((c) => c.what)).toEqual(["register", "doorbell", "claim"]);

    // 20 idle minutes: the tick doubles from 15 s to the 5-minute cap and stays there; no claim is made
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(f.gaps()).toEqual([15, 30, 60, 120, 240, 300, 300]);
    expect(intervals).toEqual([30, 60, 120, 240, 300]);
    expect(f.only("claim")).toHaveLength(1);
    // idle heartbeats every 5 minutes, carrying the interval the worker is on
    expect(f.only("heartbeat").map((c) => c.t / 1000)).toEqual([300, 600, 900, 1200]);
    expect(f.only("heartbeat").at(-1)?.interval).toBe(300_000);

    // work it cannot take (`queued` up, version unchanged): one claim per tick, still on the slow cadence
    const t1 = Date.now();
    f.state.queued = 1;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.since("claim", t1)).toHaveLength(1);
    expect(f.since("doorbell", t1)).toHaveLength(1);
    expect(intervals.at(-1)).toBe(300);
    f.state.queued = 0;

    // the version moves and a task is there: the next tick (300 s after the last) claims it and is back on 15 s
    const t2 = Date.now();
    f.state.version = 2;
    f.state.claims.push(f.claimFor("acme/demo#1"));
    const nextTick = f.only("doorbell").at(-1)!.t + 300_000;
    await vi.advanceTimersByTimeAsync(nextTick - Date.now());
    expect(f.since("claim", t2).map((c) => c.t)).toEqual([nextTick]);
    expect(jobStarted).toBe(nextTick);
    expect(intervals.at(-1)).toBe(15);
    // while the lease is held: a heartbeat every minute (on the timer's own grid), and no doorbell or claim
    await vi.advanceTimersByTimeAsync(129_000);
    const busyBeats = f.since("heartbeat", jobStarted + 1).map((c) => c.t / 1000);
    expect(busyBeats).toHaveLength(2);
    expect(busyBeats[1]! - busyBeats[0]!).toBe(60);
    expect(f.since("doorbell", jobStarted + 1)).toHaveLength(0);
    // the job finishes: one doorbell + claim right away (there may be more work), then the backoff restarts from 15 s
    await vi.advanceTimersByTimeAsync(1_000);
    const t3 = Date.now();
    expect(t3).toBe(jobStarted + 130_000);
    expect(f.since("claim", jobStarted + 1).map((c) => c.t)).toEqual([t3]);
    await vi.advanceTimersByTimeAsync(46_000);
    expect(f.gaps(t3)).toEqual([15, 30]);
    expect(intervals.slice(-3)).toEqual([15, 30, 60]);

    // stop: the loop reports offline once and returns what it ran
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    const r = await loop;
    expect(r.ran).toBe(1);
    expect(f.only("heartbeat:offline")).toHaveLength(1);
    expect(f.calls.at(-1)?.what).toBe("heartbeat:offline");
  });

  it("a site without the doorbell makes the loop claim on every tick, still backing off; --once never rings", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = fakeWorkApi();
    f.api.doorbell = async () => {
      f.calls.push({ t: Date.now(), what: "doorbell" });
      return null;
    };
    const ac = new AbortController();
    const loop = runWorker({ api: f.api, name: "fake", host: "fake.local", lanes: ["claude"], version: "0.1.0", signal: ac.signal });
    await vi.advanceTimersByTimeAsync(105_000);
    expect(f.only("claim").map((c) => c.t / 1000)).toEqual([0, 15, 45, 105]);
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    await loop;

    const g = fakeWorkApi();
    const once = await runWorker({ api: g.api, name: "fake", host: "fake.local", lanes: ["claude"], version: "0.1.0", once: true });
    expect(once.ran).toBe(0);
    expect(g.calls.map((c) => c.what)).toEqual(["register", "claim", "heartbeat:offline"]);
  });
});

describe("container login helpers (relay work container login)", () => {
  const GROK_URL = "https://auth.x.ai/oauth2/authorize?response_type=code&client_id=fx&redirect_uri=http%3A%2F%2F127.0.0.1%3A42723%2Fcallback&scope=openid&state=st4te&code_challenge=abc";
  const CODEX_URL = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=xyz";
  it("finds fx's authorize URL in its output and reads the loopback redirect it registered", () => {
    const grok = parseLoginUrl(`Open this URL in your browser to sign in:\n\n  ${GROK_URL}\n\nPaste the code shown by xAI and press enter: `);
    expect(grok).toEqual({ url: GROK_URL, redirectUri: "http://127.0.0.1:42723/callback", host: "127.0.0.1", port: 42723, path: "/callback", state: "st4te" });
    const codex = parseLoginUrl(`Sign in at ${CODEX_URL}.`);
    expect(codex).toMatchObject({ url: CODEX_URL, host: "localhost", port: 1455, path: "/auth/callback", state: "xyz" });
    // a URL without a redirect, a redirect to another host, or a cut chunk: not yet
    expect(parseLoginUrl("see https://docs.x.ai/login for help")).toBeUndefined();
    expect(parseLoginUrl("https://auth.example/authorize?redirect_uri=https%3A%2F%2Fexample.com%2Fcb")).toBeUndefined();
    expect(parseLoginUrl(GROK_URL.slice(0, 60))).toBeUndefined();
    expect(parseLoginUrl("")).toBeUndefined();
  });
  it("reads the code, state and errors from the browser's redirect, and replays it to the listener inside", () => {
    expect(parseLoginCallback("/callback?state=st4te&code=abc.def-123")).toEqual({ code: "abc.def-123", state: "st4te" });
    expect(parseLoginCallback("/auth/callback?error=access_denied&error_description=The+user+denied")).toEqual({ error: "access_denied", errorDescription: "The user denied" });
    expect(parseLoginCallback("/callback")).toEqual({});
    const codex = parseLoginUrl(CODEX_URL)!;
    expect(replayUrl(codex, "/auth/callback?code=c0de&state=xyz")).toBe("http://localhost:1455/auth/callback?code=c0de&state=xyz");
  });
  it("names the providers, their words and the by-hand steps", () => {
    expect(LOGIN_PROVIDERS).toEqual(["claude", "gh", "codex", "grok"]);
    expect(OAUTH_PROVIDERS).toEqual(["codex", "grok"]);
    expect(isLoginProvider("grok")).toBe(true);
    expect(isLoginProvider("vercel")).toBe(false);
    expect(fxLoginWords("grok")).toEqual(["env", "FX_NO_OPEN_BROWSER=1", "fx", "login", "grok"]);
    expect(manualLoginSteps("grok")[1]).toContain("paste only the code value");
    expect(manualLoginSteps("codex")[1]).toContain("fx login codex");
    expect(manualLoginSteps("gh")[1]).toContain("gh auth setup-git");
    expect(manualLoginSteps("claude")[1]).toContain("/login");
    expect(loginDonePage("grok", true)).toContain("grok: signed in");
    expect(loginDonePage("grok", false, "access_denied <x>")).toContain("access_denied &lt;x&gt;");
    expect(CONTAINER_LOGIN_COMMAND).toBe("relay work container login all");
  });
});
