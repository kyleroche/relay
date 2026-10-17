/**
 * Workers and claims: relay's own scheduler (docs/WORKERS.md). A worker is a machine that runs `relay work`; it
 * registers by name, heartbeats every minute, and claims the oldest queued task whose lane it serves and whose
 * required labels it carries. A claim is a lease (30 minutes, renewed by every heartbeat); when it runs out the
 * task is queued again. One live claim per task is enforced by a partial unique index, and the claim itself is taken
 * inside a transaction with `FOR UPDATE SKIP LOCKED`, so two workers polling the same site never run the same task.
 * `doorbell` is what an idle worker reads between claims: the queue version (db/queue.ts) and a queued estimate.
 */
import { type Db, iso, num } from "./client.ts";
import { sanitizeMeters, type MeterReading } from "../meters.ts";
import { listPreferences, type PreferenceRow } from "./memory.ts";
import { bumpQueueVersion, getQueueVersion } from "./queue.ts";
import { refreshTaskState } from "./task-state.ts";
import { taskClaims, taskEvents, deriveTaskStatus, toTask, TASK_COLS, type TaskRow } from "./tasks.ts";
import { ulid } from "../util.ts";

export { bumpQueueVersion, getQueueVersion };

export const LEASE_MS = 30 * 60_000;
/** A worker whose last heartbeat is older than this is shown offline (and `markOffline` records it). */
export const WORKER_OFFLINE_MS = 60 * 60_000;
/** Online = heartbeat within this window; between it and WORKER_OFFLINE_MS the worker is idle. */
export const WORKER_ONLINE_MS = 2 * 60_000;

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

/** A claim joined with its task and worker, for the workers page and `relay work status`. */
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

export const WORKER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface WorkerInput {
  name: string;
  host?: string;
  lanes: string[];
  labels?: string[];
  version?: string;
}

/** Register (or refresh) a worker by name. The row's id is stable across restarts; lanes and labels are replaced. */
export async function registerWorker(db: Db, w: WorkerInput): Promise<{ worker: WorkerRow; created: boolean }> {
  if (!WORKER_NAME.test(w.name)) throw new Error("worker name must be 1-64 characters: letters, digits, dot, dash, underscore");
  const lanes = [...new Set(w.lanes.map((s) => s.trim()).filter(Boolean))];
  const labels = [...new Set((w.labels ?? []).map((s) => s.trim()).filter(Boolean))];
  const r = await db.query(
    `INSERT INTO workers (id, name, host, lanes, labels, version, last_seen, status) VALUES ($1, $2, $3, $4::text[], $5::text[], $6, now(), 'online')
     ON CONFLICT (name) DO UPDATE SET host = EXCLUDED.host, lanes = EXCLUDED.lanes, labels = EXCLUDED.labels, version = EXCLUDED.version, last_seen = now(), status = 'online'
     RETURNING ${W}, (xmax = 0) AS inserted`,
    [ulid(), w.name, w.host ?? "", lanes, labels, w.version ?? ""],
  );
  const row = r[0]!;
  return { worker: toWorker(row), created: row.inserted === true || row.inserted === "t" };
}

export async function getWorker(db: Db, id: string): Promise<WorkerRow | undefined> {
  const r = await db.query(`SELECT ${W} FROM workers WHERE id = $1`, [id]);
  return r[0] ? toWorker(r[0]) : undefined;
}

export async function getWorkerByName(db: Db, name: string): Promise<WorkerRow | undefined> {
  const r = await db.query(`SELECT ${W} FROM workers WHERE name = $1`, [name]);
  return r[0] ? toWorker(r[0]) : undefined;
}

export async function listWorkers(db: Db): Promise<WorkerRow[]> {
  const r = await db.query(`SELECT ${W} FROM workers ORDER BY last_seen DESC, name ASC`);
  return r.map(toWorker);
}

/**
 * A heartbeat: touch last_seen, record the status the worker reports (the poll interval it is on and the plan meters
 * it read, when it says; a heartbeat that carries `meters` replaces the stored list, one that omits it keeps it), and
 * renew every live lease it holds. Returns the worker and the leases as they stand after renewal; undefined for an
 * unknown id.
 */
export async function heartbeatWorker(db: Db, id: string, opts: { status?: "online" | "offline"; pollMs?: number; meters?: MeterReading[]; leaseMs?: number; now?: number } = {}): Promise<{ worker: WorkerRow; leases: ClaimRow[] } | undefined> {
  const now = opts.now ?? Date.now();
  const r = await db.query(`UPDATE workers SET last_seen = $2::timestamptz, status = $3, poll_ms = coalesce($4::integer, poll_ms), meters = coalesce($5::jsonb, meters) WHERE id = $1 RETURNING ${W}`, [
    id,
    new Date(now).toISOString(),
    opts.status ?? "online",
    opts.pollMs && Number.isFinite(opts.pollMs) ? Math.round(opts.pollMs) : null,
    opts.meters ? JSON.stringify(sanitizeMeters(opts.meters) ?? []) : null,
  ]);
  if (!r[0]) return undefined;
  const leases = await db.query(`UPDATE claims SET lease_until = $2::timestamptz WHERE worker_id = $1 AND released_at IS NULL RETURNING ${C}`, [id, new Date(now + (opts.leaseMs ?? LEASE_MS)).toISOString()]);
  return { worker: toWorker(r[0]), leases: leases.map(toClaim) };
}

/** Workers that said `online` but have not been heard from for `olderThanMs`; marks them offline and returns them. */
export async function markOffline(db: Db, olderThanMs: number = WORKER_OFFLINE_MS, now: number = Date.now()): Promise<WorkerRow[]> {
  const r = await db.query(`UPDATE workers SET status = 'offline' WHERE status = 'online' AND last_seen < $1::timestamptz RETURNING ${W}`, [new Date(now - olderThanMs).toISOString()]);
  return r.map(toWorker);
}

/** Live claims whose lease ran out: mark them expired and return them (their tasks are queued again, so the queue version moves and their state cache is rewritten). */
export async function expireLeases(db: Db, now: number = Date.now()): Promise<ClaimRow[]> {
  const r = await db.query(`UPDATE claims SET released_at = $1::timestamptz, outcome = 'expired' WHERE released_at IS NULL AND lease_until < $1::timestamptz RETURNING ${C}`, [new Date(now).toISOString()]);
  if (r.length) {
    for (const c of r) await refreshTaskState(db, c.task_id as string, now);
    await bumpQueueVersion(db);
  }
  return r.map(toClaim);
}

/** State-changing kinds the doorbell looks at; the latest one per task decides whether it still looks queued. */
const QUEUE_KINDS = ["issue.labeled", "run.started", "run.dispatched", "run.failed", "run.finished", "pr.opened", "pr.merged", "pr.closed", "issue.closed", "task.approved", "task.changes_requested", "task.requeued"];

/**
 * How many tasks look claimable right now, in one query: a worker lane (optionally only `lanes`), no live lease, and
 * the latest state-changing event is none, `issue.labeled`, `pr.closed`, `task.changes_requested` (a reviewer sent
 * the PR back), `task.requeued` (an operator put it back), or a `run.started` whose lease has since ended (the worker
 * vanished). It is the quick estimate the doorbell returns, not the fold `claimNext` runs: labels a
 * task requires are not checked here, so a worker may see `queued > 0` and still get `claim: null`.
 */
export async function queuedCount(db: Db, opts: { lanes?: string[]; now?: number } = {}): Promise<number> {
  const now = new Date(opts.now ?? Date.now()).toISOString();
  const lanes = (opts.lanes ?? []).map((l) => l.trim()).filter(Boolean);
  const params: unknown[] = [now, QUEUE_KINDS];
  const laneFilter = lanes.length ? (params.push(lanes), `AND t.lane = ANY($3::text[])`) : `AND t.lane NOT LIKE '%-cloud'`;
  const r = await db.query<{ n: unknown }>(
    `SELECT count(*) AS n FROM tasks t
     LEFT JOIN LATERAL (SELECT e.kind FROM events e WHERE e.repo = t.repo AND e.issue = t.issue AND e.kind = ANY($2::text[]) ORDER BY e.ts DESC, e.id DESC LIMIT 1) le ON true
     WHERE t.lane IS NOT NULL ${laneFilter}
       AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.task_id = t.id AND c.released_at IS NULL AND c.lease_until > $1::timestamptz)
       AND (le.kind IS NULL OR le.kind IN ('issue.labeled', 'pr.closed', 'task.changes_requested', 'task.requeued')
            OR (le.kind = 'run.started' AND EXISTS (SELECT 1 FROM claims c WHERE c.task_id = t.id)))`,
    params,
  );
  return num(r[0]?.n);
}

export interface Doorbell {
  /** Moves on every write that can change what a claim returns; compare it between ticks. */
  version: number;
  /** Tasks that look claimable (for `lanes` when given). An estimate: labels are not checked. */
  queued: number;
  ts: string;
}

/** What an idle worker reads instead of claiming: the queue version and the queued estimate, two indexed reads. */
export async function doorbell(db: Db, opts: { lanes?: string[]; now?: number } = {}): Promise<Doorbell> {
  const now = opts.now ?? Date.now();
  const [version, queued] = await Promise.all([getQueueVersion(db), queuedCount(db, { ...(opts.lanes ? { lanes: opts.lanes } : {}), now })]);
  return { version, queued, ts: new Date(now).toISOString() };
}

export function workerState(w: Pick<WorkerRow, "last_seen" | "status">, now: number = Date.now()): WorkerStatus {
  if (w.status === "offline") return "offline";
  const age = now - new Date(w.last_seen).getTime();
  if (age < WORKER_ONLINE_MS) return "online";
  if (age < WORKER_OFFLINE_MS) return "idle";
  return "offline";
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

/** Workers with their derived state and current task, for the workers page and `relay work status`. */
export async function workerViews(db: Db, now: number = Date.now()): Promise<WorkerView[]> {
  const [workers, claims] = await Promise.all([listWorkers(db), liveClaims(db)]);
  return workers.map((w) => ({ ...w, state: workerState(w, now), current: claims.find((c) => c.worker_id === w.id && new Date(c.lease_until).getTime() > now) ?? null }));
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
    await bumpQueueVersion(db); // the task left the queue (or, for `released`, is back in it)
  }
  return r[0] ? toClaim(r[0]) : undefined;
}

/**
 * Labels a task's lane requires on the worker: the `lane.labels` preference (comma-separated, e.g. `gpu,xcode`),
 * narrowest scope winning: lane scope (`--scope lane --scope-id <lane>`), then project, then global.
 */
export function requiredLabels(prefs: PreferenceRow[], project: string, lane: string): string[] {
  const rank: Record<PreferenceRow["scope"], number> = { global: 0, project: 1, lane: 2, model: -1 };
  let best: PreferenceRow | undefined;
  for (const p of prefs) {
    if (p.key !== "lane.labels") continue;
    const applies = p.scope === "global" || (p.scope === "project" && p.scope_id === project) || (p.scope === "lane" && p.scope_id === lane);
    if (!applies) continue;
    if (!best || rank[p.scope] > rank[best.scope]) best = p;
  }
  return best ? best.value.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

export interface ClaimRequest {
  workerId: string;
  /** Lanes this worker serves (`claude`, `codex`, `grok`). */
  lanes: string[];
  /** Capabilities this worker advertises; a task whose `lane.labels` are not all present is skipped. */
  labels?: string[];
  leaseMs?: number;
  now?: number;
}

export interface Claimed {
  claim: ClaimRow;
  task: TaskRow & { lane: string };
}

/**
 * Claim the oldest queued task this worker can run. Expired leases are released first (those tasks are eligible
 * again). Candidates are the tasks with a matching lane, no live claim and no terminal event; each is folded to its
 * derived state and the first one that is `queued` and whose required labels the worker carries is taken inside a
 * transaction (`FOR UPDATE SKIP LOCKED` on the task row, then the live-claim check, then the insert). A race lost
 * at any step moves on to the next candidate. Undefined when nothing is claimable.
 */
export async function claimNext(db: Db, req: ClaimRequest): Promise<Claimed | undefined> {
  const now = req.now ?? Date.now();
  const lanes = req.lanes.filter(Boolean);
  if (!lanes.length) return undefined;
  await expireLeases(db, now);
  const rows = await db.query(
    `SELECT ${TASK_COLS.split(", ").map((c) => `t.${c}`).join(", ")},
            coalesce(t.lane, (SELECT e.lane FROM events e WHERE e.repo = t.repo AND e.issue = t.issue AND e.lane IS NOT NULL ORDER BY e.ts DESC, e.id DESC LIMIT 1)) AS eff_lane
     FROM tasks t
     WHERE NOT EXISTS (SELECT 1 FROM claims c WHERE c.task_id = t.id AND c.released_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.repo = t.repo AND e.issue = t.issue AND e.kind IN ('pr.merged', 'issue.closed'))
     ORDER BY t.created_at ASC, t.id ASC LIMIT 200`,
  );
  const prefs = await listPreferences(db);
  const mine = new Set(req.labels ?? []);
  for (const r of rows) {
    const lane = (r.eff_lane as string | null) ?? null;
    if (!lane || !lanes.includes(lane)) continue;
    const task = toTask(r);
    if (!requiredLabels(prefs, task.project, lane).every((l) => mine.has(l))) continue;
    const [events, claims] = await Promise.all([taskEvents(db, task), taskClaims(db, task.id)]);
    if (deriveTaskStatus(task, events, claims, now).state !== "queued") continue;
    const claim = await takeClaim(db, task.id, req.workerId, now + (req.leaseMs ?? LEASE_MS), now);
    if (claim) {
      await refreshTaskState(db, task.id, now); // the cache learns `claimed` and the worker's name
      return { claim, task: { ...task, lane } };
    }
  }
  return undefined;
}

async function takeClaim(db: Db, taskId: string, workerId: string, leaseUntil: number, now: number): Promise<ClaimRow | undefined> {
  try {
    return await db.transaction(async (tx) => {
      const locked = await tx.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE SKIP LOCKED", [taskId]);
      if (!locked[0]) return undefined;
      const live = await tx.query("SELECT 1 FROM claims WHERE task_id = $1 AND released_at IS NULL", [taskId]);
      if (live[0]) return undefined;
      const r = await tx.query(`INSERT INTO claims (id, task_id, worker_id, lease_until, claimed_at) VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz) RETURNING ${C}`, [
        ulid(now),
        taskId,
        workerId,
        new Date(leaseUntil).toISOString(),
        new Date(now).toISOString(),
      ]);
      return r[0] ? toClaim(r[0]) : undefined;
    });
  } catch {
    // unique violation on claims_live_task_idx or a serialization failure: another worker took it
    return undefined;
  }
}

/** Claims on a worker, newest first (its run history). */
export async function listClaims(db: Db, opts: { workerId?: string; taskId?: string; limit?: number } = {}): Promise<ClaimRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.workerId) {
    params.push(opts.workerId);
    where.push(`worker_id = $${params.length}`);
  }
  if (opts.taskId) {
    params.push(opts.taskId);
    where.push(`task_id = $${params.length}`);
  }
  params.push(opts.limit ?? 50);
  const r = await db.query(`SELECT ${C} FROM claims ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY claimed_at DESC LIMIT $${params.length}`, params);
  return r.map(toClaim);
}
