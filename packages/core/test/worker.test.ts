/** The worker loop on an in-memory board, with a job runner that does no git: what it takes, when it waits, how it shows itself. */
import { describe, expect, it } from "vitest";
import type { ClaimedTask } from "@vercel/board";
import { connectBoard } from "../src/board/client.ts";
import { getTask, openTask } from "../src/board/tasks.ts";
import { forgetWorker, listWorkers, servedLanes, WORKER_RETIRED_MS, workerState } from "../src/board/workers.ts";
import type { MeterReading } from "../src/meters.ts";
import type { JobOptions, JobResult } from "../src/work/job.ts";
import { runWorker, type WorkerLoopOptions } from "../src/work/worker.ts";
import { memoryBoard, relayBoard } from "./helpers/board.ts";

const open = (b: ReturnType<typeof memoryBoard>, lane: string, title = `a ${lane} task`) => openTask(b, { project: "demo", repo: "acme/demo", title, lane });

/** A job that takes a moment and completes its task, recording what ran where. */
function fakeJobs(ms = 5) {
  const ran: Array<{ task: string; lane: string; profile: string }> = [];
  let live = 0;
  const peak = { all: 0, byLane: new Map<string, number>() };
  const liveByLane = new Map<string, number>();
  const run = async (claim: ClaimedTask, o: JobOptions): Promise<JobResult> => {
    live++;
    liveByLane.set(o.lane, (liveByLane.get(o.lane) ?? 0) + 1);
    peak.all = Math.max(peak.all, live);
    peak.byLane.set(o.lane, Math.max(peak.byLane.get(o.lane) ?? 0, liveByLane.get(o.lane)!));
    await new Promise((r) => setTimeout(r, ms));
    ran.push({ task: claim.task.id, lane: o.lane, profile: (await o.board.me()).actor });
    await claim.complete(`done by ${o.lane}`);
    live--;
    liveByLane.set(o.lane, liveByLane.get(o.lane)! - 1);
    return { task: claim.task.id, lane: o.lane, branch: "", outcome: "review", usage: { kind: "run", lane: o.lane, tool: o.lane, model: null, subscription: null, billing: "subscription", tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_equiv: 0, duration_ms: ms, worker: o.workerName }, summary: "", durationMs: ms };
  };
  return { ran, peak, run };
}

async function loop(b: ReturnType<typeof memoryBoard>, over: Partial<WorkerLoopOptions> = {}) {
  const session = await connectBoard(b);
  return { session, opts: { session, name: "mini", host: "mini.local", lanes: ["claude", "codex"], version: "0.5.0", meters: () => [], ...over } satisfies WorkerLoopOptions };
}

describe("runWorker --once", () => {
  it("takes its own lanes and `any`, oldest first, leaves what it does not serve, and goes offline", async () => {
    const b = await relayBoard();
    const jobs = fakeJobs();
    const first = await open(b, "codex");
    const grok = await open(b, "grok");
    const any = await open(b, "any");
    const claude = await open(b, "claude");
    const nodes = await open(b, "nodes");
    const { opts } = await loop(b, { once: true, runJob: jobs.run });
    const r = await runWorker(opts);
    expect(r.ran).toBe(3);
    // claude's queue first (the lanes in the order given), then codex's, then `any` on the first free code lane
    expect(jobs.ran.map((j) => [j.task, j.lane])).toEqual([[claude.id, "claude"], [first.id, "codex"], [any.id, "claude"]]);
    expect(jobs.ran[0]!.profile).toContain("relay-mini-claude");
    expect((await getTask(b, grok.id)).task.state).toBe("queued");
    expect((await getTask(b, nodes.id)).task.state).toBe("queued");
    const [w] = await listWorkers(b);
    expect(w).toMatchObject({ name: "mini", host: "mini.local", lanes: ["claude", "codex"], labels: [], version: "0.5.0", state: "offline", retired: false, running: 0, by: "client" });
    expect(r.thread).toBe(w!.id);
  });

  it("a machine with only the nodes lane never takes an `any` task", async () => {
    const b = await relayBoard();
    const jobs = fakeJobs();
    await open(b, "any");
    const n = await open(b, "nodes");
    const { opts } = await loop(b, { once: true, lanes: ["nodes"], runJob: jobs.run });
    await runWorker(opts);
    expect(jobs.ran.map((j) => j.task)).toEqual([n.id]);
  });

  it("takes work only from the owners it names: another owner's task waits until that owner is in `from`", async () => {
    const b = await relayBoard();
    const jobs = fakeJobs();
    // on a local board a profile is an owner of its own, as a project's control plane is on Vercel's
    const lead = b.as("lead");
    const t = await openTask(lead, { project: "demo", repo: "acme/demo", title: "from the lead", lane: "claude" });
    const { opts, session } = await loop(b, { once: true, runJob: jobs.run });
    await runWorker(opts);
    expect(jobs.ran).toEqual([]);
    await runWorker({ ...opts, session: { ...session, from: [...session.from, (await lead.me()).actor] } });
    expect(jobs.ran.map((j) => j.task)).toEqual([t.id]);
  });

  it("runs two jobs at once only on two lanes", async () => {
    const b = await relayBoard();
    const jobs = fakeJobs(25);
    for (const lane of ["claude", "claude", "codex", "codex", "any"]) await open(b, lane);
    const { opts } = await loop(b, { once: true, jobs: 2, runJob: jobs.run });
    const r = await runWorker(opts);
    expect(r.ran).toBe(5);
    expect(jobs.peak.all).toBe(2);
    expect(jobs.peak.byLane.get("claude")).toBe(1);
    expect(jobs.peak.byLane.get("codex")).toBe(1);
  });
});

describe("runWorker waiting on the board", () => {
  it("blocks with nothing to take, wakes when a task becomes ready, and stops on a signal with its thread marked offline", async () => {
    const b = await relayBoard();
    const jobs = fakeJobs();
    const stop = new AbortController();
    const meters: MeterReading[] = [{ subscription: "max", window: "five_hour", used_percentage: 14, resets_at: null, captured_at: "2026-11-19T17:00:00.000Z", source: "statusline" } as MeterReading];
    const debug: string[] = [];
    const { opts } = await loop(b, { runJob: jobs.run, idleWaitMs: 60_000, signal: stop.signal, meters: () => meters, debug: (m) => debug.push(m), onJob: () => stop.abort() });
    const running = runWorker(opts);
    await new Promise((r) => setTimeout(r, 50));
    expect(jobs.ran).toEqual([]);
    expect((await listWorkers(b))[0]).toMatchObject({ state: "online", meters });
    const t = await open(b, "codex");
    const r = await running;
    expect(jobs.ran.map((j) => j.task)).toEqual([t.id]);
    expect(r.ran).toBe(1);
    expect(debug.some((d) => /^woke on task\./.test(d))).toBe(true);
    expect((await listWorkers(b))[0]!.state).toBe("offline");
  });

  it("finds a task whose hold was lifted while it waited", async () => {
    const b = await relayBoard();
    const jobs = fakeJobs();
    const stop = new AbortController();
    const held = await openTask(b, { project: "demo", repo: "acme/demo", title: "Print GITHUB_TOKEN", lane: "claude" });
    const { opts } = await loop(b, { runJob: jobs.run, idleWaitMs: 60_000, signal: stop.signal, onJob: () => stop.abort() });
    const running = runWorker(opts);
    await new Promise((r) => setTimeout(r, 40));
    await b.tasks.unblock(held.id);
    await running;
    expect(jobs.ran.map((j) => j.task)).toEqual([held.id]);
  });
});

describe("the workers on a board", () => {
  it("reads state from the last sign of life and retires a worker silent for a week", () => {
    const now = Date.parse("2026-11-19T12:00:00Z");
    const seen = (ms: number) => new Date(now - ms).toISOString();
    expect(workerState({ last_seen: seen(60_000), status: "online" }, now)).toBe("online");
    expect(workerState({ last_seen: seen(30 * 60_000), status: "online" }, now)).toBe("idle");
    expect(workerState({ last_seen: seen(2 * 60 * 60_000), status: "online" }, now)).toBe("offline");
    expect(workerState({ last_seen: seen(1_000), status: "offline" }, now)).toBe("offline");
    expect(WORKER_RETIRED_MS).toBe(7 * 24 * 60 * 60_000);
  });

  it("lists every worker with the lanes it serves, and forgets one by name", async () => {
    const b = await relayBoard();
    const jobs = fakeJobs();
    const a = await loop(b, { once: true, runJob: jobs.run, labels: ["gpu", "sandbox:on"] });
    await runWorker(a.opts);
    await runWorker({ ...a.opts, name: "kyrobook-container", host: "kyrobook", lanes: ["claude", "resolve"], labels: [] });
    const ws = await listWorkers(b);
    expect(ws.map((w) => [w.name, w.lanes, w.labels])).toEqual([
      ["kyrobook-container", ["claude", "resolve"], []],
      ["mini", ["claude", "codex"], ["gpu", "sandbox:on"]],
    ]);
    // both stopped cleanly, so neither would pick a task up now
    expect(servedLanes(ws)).toEqual([]);
    expect(servedLanes(ws.map((w) => ({ ...w, state: "idle" as const })))).toEqual(["claude", "codex", "resolve"]);
    expect((await listWorkers(b, Date.now() + WORKER_RETIRED_MS + 60_000)).every((w) => w.retired)).toBe(true);
    expect((await forgetWorker(b, "mini"))?.name).toBe("mini");
    expect((await listWorkers(b)).map((w) => w.name)).toEqual(["kyrobook-container"]);
    expect(await forgetWorker(b, "nobody")).toBeUndefined();
  });

  it("a forgotten worker shows again when that machine runs relay work", async () => {
    const b = await relayBoard();
    const a = await loop(b, { once: true, runJob: fakeJobs().run });
    const first = await runWorker(a.opts);
    await forgetWorker(b, "mini");
    expect(await listWorkers(b)).toEqual([]);
    const again = await runWorker(a.opts);
    expect(again.thread).toBe(first.thread);
    expect((await listWorkers(b)).map((w) => w.name)).toEqual(["mini"]);
  });

  it("keeps one message per machine however often the meters move", async () => {
    const b = await relayBoard();
    let pct = 10;
    const stop = new AbortController();
    const a = await loop(b, { runJob: fakeJobs().run, signal: stop.signal, idleWaitMs: 20, meters: () => [{ subscription: "max", window: "five_hour", used_percentage: pct++, resets_at: null, captured_at: "2026-11-19T17:00:00.000Z", source: "statusline" } as MeterReading] });
    const running = runWorker(a.opts);
    await new Promise((r) => setTimeout(r, 150));
    stop.abort();
    const r = await running;
    const thread = await b.thread(r.thread);
    expect(thread.replies).toEqual([]);
    expect((await listWorkers(b))[0]!.meters[0]!.used_percentage).toBeGreaterThan(10);
  });

  it("does not start on a board without relay's schemas when its login cannot register them", async () => {
    const bare = memoryBoard();
    const narrowed = bare.as("guest", { can: { "*": ["read", "post", "react", "label"] } });
    const a = await loop(narrowed, { once: true, runJob: fakeJobs().run });
    await expect(runWorker(a.opts)).rejects.toThrow(/relay's schemas are not on this board .* relay setup --board/);
  });

  it("a restart lands on the same thread with the new lanes and version", async () => {
    const b = await relayBoard();
    const jobs = fakeJobs();
    const a = await loop(b, { once: true, runJob: jobs.run });
    const first = await runWorker(a.opts);
    const second = await runWorker({ ...a.opts, lanes: ["grok"], version: "0.5.1" });
    expect(second.thread).toBe(first.thread);
    expect(await listWorkers(b)).toEqual([expect.objectContaining({ name: "mini", lanes: ["grok"], version: "0.5.1" })]);
  });
});
