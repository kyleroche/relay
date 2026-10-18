/**
 * The worker protocol, server side (docs/WORKERS.md). One function per route, over a database handle, so the web
 * routes under /api/v1/workers and /api/v1/work, the local-mode CLI and the tests all run the same code:
 *
 *   register   POST /api/v1/workers                       upsert by name; worker.registered on first sight, worker.online when it comes back
 *   heartbeat  POST /api/v1/workers/{id}/heartbeat        touch last_seen, store the plan meters, renew the worker's leases; `offline` writes worker.offline
 *   doorbell   GET  /api/v1/work/doorbell                 the queue version and a queued estimate; what an idle worker reads instead of claiming
 *   claim      POST /api/v1/work/claim                    the oldest queued task for the worker's lanes and labels, under a 30-minute lease
 *   start      POST /api/v1/work/{task}/start             run.started (the clone is ready and the lane is about to run)
 *   release    POST /api/v1/work/{task}/release           run.finished or run.failed plus the step.usage row; `released` just frees the lease;
 *                                                        `held` frees it and writes task.held (the injection gate, tasks/gate.ts)
 *   forget     DELETE /api/v1/workers/{id}               remove a retired worker's row (by id or name); 409 while it holds a live claim; worker.forgotten
 *
 * Every row these write carries the worker as `runner:<name>`, the actor the feed, the task derivation and the
 * workers page already understand. A worker cannot write arbitrary kinds: the shape is fixed here.
 */
import type { Db } from "../db/client.ts";
import { writeEvent, type EventRow } from "../db/events.ts";
import { getProject } from "../db/projects.ts";
import { getTask, type TaskRow } from "../db/tasks.ts";
import { claimNext, doorbell, forgetWorker, getWorker, getWorkerByName, heartbeatWorker, liveClaim, registerWorker, releaseClaim, workerViews, type ClaimRow, type Doorbell, type WorkerInput, type WorkerRow, type WorkerView } from "../db/workers.ts";
import type { GitHubClient } from "../github/client.ts";
import type { MeterReading } from "../meters.ts";
import { heldEvent, type GateVerdict } from "../tasks/gate.ts";
import { reviewNotes } from "../tasks/review.ts";

export class WorkError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "WorkError";
  }
}

export interface RegisterResult {
  worker: WorkerRow;
  created: boolean;
  events: EventRow[];
}

export interface HeartbeatInput {
  status?: "online" | "offline";
  /** The poll interval the worker is on (ms), for the workers page and `relay work status`. */
  interval_ms?: number;
  /** The plan meters read on this machine (`meters.ts`); present replaces the stored list, absent keeps it. */
  meters?: MeterReading[];
}

export interface DoorbellInput {
  /** Count only tasks for these lanes (the worker's); every worker lane otherwise. */
  lanes?: string[];
}

export interface HeartbeatResult {
  worker: WorkerRow;
  leases: ClaimRow[];
  events: EventRow[];
}

export interface ClaimInput {
  worker_id: string;
  /** Restrict to these lanes (default: the worker's registered lanes). */
  lanes?: string[];
  labels?: string[];
}

export interface ClaimedIssue {
  number: number;
  title: string;
  body: string;
  url: string;
}

export interface ClaimResult {
  claim: ClaimRow;
  task: TaskRow & { lane: string };
  /** The issue text when the server could read it (GitHub token); the worker reads it with gh otherwise. */
  issue: ClaimedIssue | null;
  /** The repository's default branch when known, else null (the worker asks git). */
  base: string | null;
  /** The latest `task.changes_requested` note, when a reviewer sent the task back; the gate grades it with the issue. */
  note?: string | null;
}

export interface StartInput {
  worker_id: string;
  branch?: string;
  host?: string;
}

/** The usage line one lane run produced, as the worker measured it. */
export interface RunUsage {
  tool: string;
  model: string | null;
  subscription: string | null;
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_write: number;
  cost_equiv: number;
  duration_ms: number;
}

export interface ReleaseInput {
  worker_id: string;
  /** `held`: the injection gate flagged the task's text; the lease is freed and `task.held` written (tasks/gate.ts). */
  outcome: "finished" | "failed" | "released" | "held";
  /** For `finished`: `success` (a PR exists) or another non-failing word; a failing word makes the task `failed`. */
  conclusion?: string;
  summary?: string;
  error?: string;
  pr?: number | null;
  pr_url?: string | null;
  duration_ms?: number | null;
  usage?: RunUsage | null;
  /** For `held`: what the gate found. */
  gate?: Pick<GateVerdict, "score" | "reasons" | "grader" | "model"> | null;
  /** The gate's own model call, when one ran (with any outcome): written as a `step.usage` row on lane `gate`. */
  gate_usage?: RunUsage | null;
}

export interface ReleaseResult {
  claim: ClaimRow;
  events: EventRow[];
}

const actorOf = (w: Pick<WorkerRow, "name">): string => `runner:${w.name}`;

export async function registerWorkerServer(db: Db, input: WorkerInput): Promise<RegisterResult> {
  const before = await getWorkerByName(db, input.name);
  const { worker, created } = await registerWorker(db, input);
  const events: EventRow[] = [];
  const payload = { worker: worker.id, host: worker.host, lanes: worker.lanes, labels: worker.labels, version: worker.version };
  if (created) {
    const e = await writeEvent(db, { kind: "worker.registered", actor: actorOf(worker), summary: `${worker.name} registered (${worker.lanes.join(", ") || "no lanes"})`, payload });
    if (e) events.push(e);
  }
  if (created || !before || before.status === "offline") {
    const e = await writeEvent(db, { kind: "worker.online", actor: actorOf(worker), summary: `${worker.name} online: ${worker.lanes.join(", ") || "no lanes"}`, payload });
    if (e) events.push(e);
  }
  return { worker, created, events };
}

export async function heartbeatServer(db: Db, workerId: string, input: HeartbeatInput = {}): Promise<HeartbeatResult> {
  const r = await heartbeatWorker(db, workerId, { ...(input.status ? { status: input.status } : {}), ...(input.interval_ms ? { pollMs: input.interval_ms } : {}), ...(input.meters ? { meters: input.meters } : {}) });
  if (!r) throw new WorkError(`No worker ${workerId}; register first.`, 404);
  const events: EventRow[] = [];
  if (input.status === "offline") {
    const e = await writeEvent(db, { kind: "worker.offline", actor: actorOf(r.worker), summary: `${r.worker.name} offline`, payload: { worker: r.worker.id, host: r.worker.host } });
    if (e) events.push(e);
  }
  return { ...r, events };
}

/** The doorbell: no worker row is touched, nothing is written; one cheap read for the idle loop (docs/WORKERS.md). */
export const doorbellServer = (db: Db, input: DoorbellInput = {}): Promise<Doorbell> => doorbell(db, { ...(input.lanes?.length ? { lanes: input.lanes } : {}) });

export async function claimServer(db: Db, input: ClaimInput, opts: { github?: GitHubClient | undefined } = {}): Promise<ClaimResult | null> {
  const worker = await getWorker(db, input.worker_id);
  if (!worker) throw new WorkError(`No worker ${input.worker_id}; register first.`, 404);
  const lanes = input.lanes?.length ? input.lanes.filter((l) => worker.lanes.includes(l)) : worker.lanes;
  const labels = [...new Set([...worker.labels, ...(input.labels ?? [])])];
  const got = await claimNext(db, { workerId: worker.id, lanes, labels });
  if (!got) return null;
  let issue: ClaimedIssue | null = null;
  if (opts.github) {
    try {
      const i = await opts.github.getIssue(got.task.repo, got.task.issue);
      issue = { number: i.number, title: i.title, body: i.body, url: i.html_url };
    } catch {
      /* the worker falls back to gh */
    }
  }
  // the latest reviewer note rides along so the worker's gate grades it with the issue (the brief carries it too, but the brief is not graded)
  const notes = await reviewNotes(db, got.task, 1).catch(() => []);
  return { claim: got.claim, task: got.task, issue, base: null, note: notes.at(-1)?.note ?? null };
}

export async function startServer(db: Db, taskId: string, input: StartInput): Promise<{ claim: ClaimRow; events: EventRow[] }> {
  const worker = await getWorker(db, input.worker_id);
  if (!worker) throw new WorkError(`No worker ${input.worker_id}.`, 404);
  const claim = await liveClaim(db, taskId, worker.id);
  if (!claim) throw new WorkError(`${worker.name} holds no live claim on ${taskId}.`, 409);
  const task = await getTask(db, taskId);
  if (!task) throw new WorkError(`No task ${taskId}.`, 404);
  const lane = task.lane;
  const e = await writeEvent(db, {
    kind: "run.started",
    actor: actorOf(worker),
    project: task.project,
    repo: task.repo,
    issue: task.issue,
    lane,
    summary: `${lane ?? "lane"} on ${worker.name}${input.branch ? ` (${input.branch})` : ""}`,
    url: `https://github.com/${task.repo}/issues/${task.issue}`,
    payload: { worker: worker.id, host: input.host ?? worker.host, branch: input.branch ?? null, labels: worker.labels, claim: claim.id },
    dedupe_key: `run:${claim.id}:started`,
  });
  return { claim, events: e ? [e] : [] };
}

export async function releaseServer(db: Db, taskId: string, input: ReleaseInput): Promise<ReleaseResult> {
  const worker = await getWorker(db, input.worker_id);
  if (!worker) throw new WorkError(`No worker ${input.worker_id}.`, 404);
  const task = await getTask(db, taskId);
  if (!task) throw new WorkError(`No task ${taskId}.`, 404);
  // a hold gives the lease back (`released`): the task.held row below is what keeps it off the queue
  const claim = await releaseClaim(db, taskId, worker.id, input.outcome === "held" ? "released" : input.outcome);
  if (!claim) throw new WorkError(`${worker.name} holds no live claim on ${taskId}.`, 409);
  const events: EventRow[] = [];
  const lane = task.lane;
  const base = { actor: actorOf(worker), project: task.project, repo: task.repo, issue: task.issue, lane, pr: input.pr ?? null, duration_ms: input.duration_ms ?? null };
  if (input.outcome === "held") {
    const gate = input.gate ?? { score: 1, reasons: [input.error ?? input.summary ?? "flagged by the gate"], grader: "precheck", model: null };
    const e = await writeEvent(db, heldEvent(task, actorOf(worker), { score: gate.score, reasons: gate.reasons, grader: gate.grader, model: gate.model ?? null }, { payload: { worker: worker.id, claim: claim.id }, dedupe_key: `run:${claim.id}:held` }));
    if (e) events.push(e);
  } else if (input.outcome === "finished") {
    const conclusion = input.conclusion ?? "success";
    const e = await writeEvent(db, {
      ...base,
      kind: "run.finished",
      summary: input.summary?.slice(0, 500) ?? `${lane ?? "lane"} finished on ${worker.name}`,
      url: input.pr_url ?? null,
      payload: { conclusion, worker: worker.id, claim: claim.id, pr: input.pr ?? null },
      dedupe_key: `run:${claim.id}:finished`,
    });
    if (e) events.push(e);
  } else if (input.outcome === "failed") {
    const e = await writeEvent(db, {
      ...base,
      kind: "run.failed",
      summary: (input.error ?? input.summary ?? `${lane ?? "lane"} failed on ${worker.name}`).slice(0, 500),
      url: input.pr_url ?? null,
      payload: { worker: worker.id, claim: claim.id, error: input.error ?? null },
      dedupe_key: `run:${claim.id}:failed`,
    });
    if (e) events.push(e);
  }
  const u = input.usage;
  if (u && (u.tokens_in || u.tokens_out || u.cache_read)) {
    const e = await writeEvent(db, {
      kind: "step.usage",
      actor: `agent:${lane ?? u.tool}`,
      project: task.project,
      repo: task.repo,
      issue: task.issue,
      pr: input.pr ?? null,
      lane,
      model: u.model,
      subscription: u.subscription,
      tokens_in: u.tokens_in,
      tokens_out: u.tokens_out,
      cache_read: u.cache_read,
      cache_write: u.cache_write,
      cost_equiv: u.cost_equiv,
      duration_ms: u.duration_ms,
      summary: `${u.model ?? u.tool}: ${u.tokens_in + u.cache_read} in / ${u.tokens_out} out`,
      url: input.pr_url ?? null,
      payload: { tool: u.tool, worker: worker.id, claim: claim.id, mode: "code" },
      dedupe_key: `usage:${claim.id}`,
    });
    if (e) events.push(e);
  }
  // the gate's own call, like every other model call: one step.usage row, on lane `gate` (docs/SECURITY.md, "The gate")
  const g = input.gate_usage;
  if (g && (g.tokens_in || g.tokens_out || g.cache_read || g.cache_write)) {
    const e = await writeEvent(db, {
      kind: "step.usage",
      actor: "agent:gate",
      project: task.project,
      repo: task.repo,
      issue: task.issue,
      lane: "gate",
      model: g.model,
      subscription: g.subscription,
      tokens_in: g.tokens_in,
      tokens_out: g.tokens_out,
      cache_read: g.cache_read,
      cache_write: g.cache_write,
      cost_equiv: g.cost_equiv,
      duration_ms: g.duration_ms,
      summary: `gate ${g.model ?? g.tool}: ${g.tokens_in + g.cache_read} in / ${g.tokens_out} out`,
      url: `https://github.com/${task.repo}/issues/${task.issue}`,
      payload: { tool: g.tool, worker: worker.id, claim: claim.id, mode: "gate", verdict: input.outcome === "held" ? "hold" : "clear" },
      dedupe_key: `usage:${claim.id}:gate`,
    });
    if (e) events.push(e);
  }
  return { claim, events };
}

export const listWorkersServer = (db: Db): Promise<WorkerView[]> => workerViews(db);

export interface ForgottenResult {
  worker: WorkerRow;
  events: EventRow[];
}

/**
 * Forget a worker (`relay work forget`, DELETE /api/v1/workers/{id}): the row goes, `worker.forgotten` is written as
 * the caller (not the worker: it is not the one speaking), with the worker's name and last sighting in the payload.
 * 404 for an unknown id or name, 409 while the worker holds a live claim. Reversible by running `relay work` on the
 * machine again, which registers a fresh row under the same name.
 */
export async function forgetWorkerServer(db: Db, idOrName: string, actor: string): Promise<ForgottenResult> {
  const r = await forgetWorker(db, idOrName);
  if (r.outcome === "unknown") throw new WorkError(`No worker '${idOrName}'.`, 404);
  if (r.outcome === "busy") throw new WorkError(`${r.worker.name} holds a live claim on ${r.claim.task_id} (lease until ${r.claim.lease_until}); wait for it to finish or requeue the task first.`, 409);
  const { worker } = r;
  const e = await writeEvent(db, {
    kind: "worker.forgotten",
    actor,
    summary: `${worker.name} forgotten (last seen ${worker.last_seen.slice(0, 16)}Z)`,
    payload: { worker: worker.id, name: worker.name, host: worker.host, lanes: worker.lanes, labels: worker.labels, version: worker.version, last_seen: worker.last_seen },
  });
  return { worker, events: e ? [e] : [] };
}

/** The project row a claimed task belongs to (its repo is what the worker clones). */
export const taskProject = (db: Db, task: Pick<TaskRow, "project">) => getProject(db, task.project);
