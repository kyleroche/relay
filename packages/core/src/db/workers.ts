/**
 * The `workers` and `claims` tables (docs/WORKERS.md): a worker's row with its derived state, and the leases the task
 * fold reads. A claim is a lease on a task; when it runs out `expireLeases` marks it expired and the task is queued
 * again. One live claim per task is enforced by a partial unique index.
 */
import { type Db, iso, num } from "./client.ts";
import { sanitizeMeters, type MeterReading } from "../meters.ts";
import { refreshTaskState } from "./task-state.ts";

/** A worker whose last heartbeat is older than this is shown offline. */
export const WORKER_OFFLINE_MS = 60 * 60_000;
/** Online = heartbeat within this window; between it and WORKER_OFFLINE_MS the worker is idle. */
export const WORKER_ONLINE_MS = 2 * 60_000;
/** A worker offline for longer than this is retired: the workers page folds it away and the board stops drawing it. */
export const WORKER_RETIRED_MS = 7 * 24 * 60 * 60_000;

export type WorkerStatus = "online" | "idle" | "offline";

export interface WorkerRow {
  id: string;
  name: string;
  host: string;
  lanes: string[];
  labels: string[];
  version: string;
  last_seen: string;
  /** What the worker last reported: `online`, or `offline` when it shut down cleanly. */
  status: "online" | "offline";
  /** The poll interval (ms) the worker reported with its last heartbeat; null until one did. */
  poll_ms: number | null;
  /** Plan meters the worker sent with its last heartbeat (`meters.ts`); empty until one did. */
  meters: MeterReading[];
  created_at: string;
}

export interface ClaimRow {
  id: string;
  task_id: string;
  worker_id: string;
  lease_until: string;
  claimed_at: string;
  released_at: string | null;
  outcome: ClaimOutcome | null;
}

export type ClaimOutcome = "finished" | "failed" | "released" | "expired";

/** A claim joined with its task and worker, for the workers page. */
export interface LiveClaim extends ClaimRow {
  worker: string;
  project: string;
  repo: string;
  issue: number;
  lane: string | null;
}

export interface WorkerView extends WorkerRow {
  /** Derived from last_seen: online under 2 minutes, idle under an hour, offline beyond (or when the worker said so). */
  state: WorkerStatus;
  /** Offline for more than WORKER_RETIRED_MS (7 days): folded away on the workers page, left off the board. */
  retired: boolean;
  current: LiveClaim | null;
}

const W = "id, name, host, lanes, labels, version, last_seen, status, poll_ms, meters, created_at";
const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).map(String) : typeof v === "string" && v.startsWith("{") ? v.slice(1, -1).split(",").filter(Boolean) : []);
const toWorker = (r: Record<string, unknown>): WorkerRow => ({
  id: r.id as string,
  name: r.name as string,
  host: (r.host as string) ?? "",
  lanes: arr(r.lanes),
  labels: arr(r.labels),
  version: (r.version as string) ?? "",
  last_seen: iso(r.last_seen) ?? "",
  status: r.status === "offline" ? "offline" : "online",
  poll_ms: r.poll_ms === null || r.poll_ms === undefined ? null : num(r.poll_ms),
  meters: sanitizeMeters(typeof r.meters === "string" ? JSON.parse(r.meters) : r.meters) ?? [],
  created_at: iso(r.created_at) ?? "",
});

const C = "id, task_id, worker_id, lease_until, claimed_at, released_at, outcome";
const toClaim = (r: Record<string, unknown>): ClaimRow => ({
  id: r.id as string,
  task_id: r.task_id as string,
  worker_id: r.worker_id as string,
  lease_until: iso(r.lease_until) ?? "",
  claimed_at: iso(r.claimed_at) ?? "",
  released_at: iso(r.released_at),
  outcome: (r.outcome as ClaimOutcome | null) ?? null,
});

export async function getWorker(db: Db, id: string): Promise<WorkerRow | undefined> {
  const r = await db.query(`SELECT ${W} FROM workers WHERE id = $1`, [id]);
  return r[0] ? toWorker(r[0]) : undefined;
}

export async function listWorkers(db: Db): Promise<WorkerRow[]> {
  const r = await db.query(`SELECT ${W} FROM workers ORDER BY last_seen DESC, name ASC`);
  return r.map(toWorker);
}

/** Live claims whose lease ran out: mark them expired and return them (their tasks are queued again, so their state cache is rewritten). */
export async function expireLeases(db: Db, now: number = Date.now()): Promise<ClaimRow[]> {
  const r = await db.query(`UPDATE claims SET released_at = $1::timestamptz, outcome = 'expired' WHERE released_at IS NULL AND lease_until < $1::timestamptz RETURNING ${C}`, [new Date(now).toISOString()]);
  for (const c of r) await refreshTaskState(db, c.task_id as string, now);
  return r.map(toClaim);
}

export function workerState(w: Pick<WorkerRow, "last_seen" | "status">, now: number = Date.now()): WorkerStatus {
  if (w.status === "offline") return "offline";
  const age = now - new Date(w.last_seen).getTime();
  if (age < WORKER_ONLINE_MS) return "online";
  if (age < WORKER_OFFLINE_MS) return "idle";
  return "offline";
}

/** Retired = offline and silent for more than WORKER_RETIRED_MS; a clean `offline` report alone does not retire a worker. */
export function workerRetired(w: Pick<WorkerRow, "last_seen" | "status">, now: number = Date.now()): boolean {
  return workerState(w, now) === "offline" && now - new Date(w.last_seen).getTime() > WORKER_RETIRED_MS;
}

/** Every live claim with its task and worker, newest first. */
export async function liveClaims(db: Db, opts: { workerId?: string } = {}): Promise<LiveClaim[]> {
  const params: unknown[] = [];
  const where = opts.workerId ? (params.push(opts.workerId), "AND c.worker_id = $1") : "";
  const r = await db.query(
    `SELECT c.id, c.task_id, c.worker_id, c.lease_until, c.claimed_at, c.released_at, c.outcome, w.name AS worker, t.project, t.repo, t.issue, t.lane
     FROM claims c JOIN workers w ON w.id = c.worker_id JOIN tasks t ON t.id = c.task_id
     WHERE c.released_at IS NULL ${where} ORDER BY c.claimed_at DESC`,
    params,
  );
  return r.map((x) => ({ ...toClaim(x), worker: x.worker as string, project: x.project as string, repo: x.repo as string, issue: Number(x.issue), lane: (x.lane as string | null) ?? null }));
}

/** Workers with their derived state and current task, for the workers page. */
export async function workerViews(db: Db, now: number = Date.now()): Promise<WorkerView[]> {
  const [workers, claims] = await Promise.all([listWorkers(db), liveClaims(db)]);
  return workers.map((w) => ({ ...w, state: workerState(w, now), retired: workerRetired(w, now), current: claims.find((c) => c.worker_id === w.id && new Date(c.lease_until).getTime() > now) ?? null }));
}

/** The live claim a worker holds on a task, if any. */
export async function liveClaim(db: Db, taskId: string, workerId?: string): Promise<ClaimRow | undefined> {
  const params: unknown[] = [taskId];
  const extra = workerId ? (params.push(workerId), "AND worker_id = $2") : "";
  const r = await db.query(`SELECT ${C} FROM claims WHERE task_id = $1 AND released_at IS NULL ${extra}`, params);
  return r[0] ? toClaim(r[0]) : undefined;
}

/** End a live claim with an outcome. Undefined when the worker holds no live claim on the task. */
export async function releaseClaim(db: Db, taskId: string, workerId: string, outcome: Exclude<ClaimOutcome, "expired">, now: number = Date.now()): Promise<ClaimRow | undefined> {
  const r = await db.query(`UPDATE claims SET released_at = $3::timestamptz, outcome = $4 WHERE task_id = $1 AND worker_id = $2 AND released_at IS NULL RETURNING ${C}`, [taskId, workerId, new Date(now).toISOString(), outcome]);
  if (r[0]) {
    await refreshTaskState(db, taskId, now); // `claimed` ends: the cache says what the feed says now
  }
  return r[0] ? toClaim(r[0]) : undefined;
}
